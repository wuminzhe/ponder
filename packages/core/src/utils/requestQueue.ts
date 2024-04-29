import type { Common } from "@/common/common.js";
import type { Network } from "@/config/networks.js";
import { type Queue, createQueue } from "@ponder/common";
import {
  type GetLogsRetryHelperParameters,
  getLogsRetryHelper,
} from "@ponder/utils";
import {
  type EIP1193Parameters,
  HttpRequestError,
  InternalRpcError,
  LimitExceededRpcError,
  type PublicRpcSchema,
  RpcError,
  type RpcLog,
  hexToBigInt,
  isHex,
} from "viem";
import { startClock } from "./timer.js";
import { wait } from "./wait.js";

type RequestReturnType<
  method extends EIP1193Parameters<PublicRpcSchema>["method"],
> = Extract<PublicRpcSchema[number], { Method: method }>["ReturnType"];

export type RequestQueue = Omit<
  Queue<
    RequestReturnType<EIP1193Parameters<PublicRpcSchema>["method"]>,
    EIP1193Parameters<PublicRpcSchema>
  >,
  "add"
> & {
  request: <TParameters extends EIP1193Parameters<PublicRpcSchema>>(
    parameters: TParameters,
  ) => Promise<RequestReturnType<TParameters["method"]>>;
};

/**
 * Creates a queue built to manage rpc requests.
 */
export const createRequestQueue = ({
  network,
  common,
}: {
  network: Network;
  common: Common;
}): RequestQueue => {
  const fetchRequest = async (request: EIP1193Parameters<PublicRpcSchema>) => {
    for (let i = 0; i < 4; i++) {
      try {
        const stopClock = startClock();
        const response = await network.transport.request(request);
        common.metrics.ponder_rpc_request_duration.observe(
          { method: request.method, network: network.name },
          stopClock(),
        );

        return response;
      } catch (_error) {
        const error = _error as Error;

        if (
          request.method === "eth_getLogs" &&
          isHex(request.params[0].fromBlock) &&
          isHex(request.params[0].toBlock)
        ) {
          const getLogsErrorResponse = getLogsRetryHelper({
            params: request.params as GetLogsRetryHelperParameters["params"],
            error: error as RpcError,
          });

          if (getLogsErrorResponse.shouldRetry === false) throw error;

          common.logger.debug({
            service: "sync",
            msg: `Caught eth_getLogs error on '${
              network.name
            }', retrying with ranges: [${getLogsErrorResponse.ranges
              .map(
                ({ fromBlock, toBlock }) =>
                  `[${hexToBigInt(fromBlock).toString()}, ${hexToBigInt(
                    toBlock,
                  ).toString()}]`,
              )
              .join(", ")}].`,
          });

          const logs: RpcLog[] = [];
          for (const { fromBlock, toBlock } of getLogsErrorResponse.ranges) {
            const _logs = await fetchRequest({
              method: "eth_getLogs",
              params: [
                {
                  topics: request.params![0].topics,
                  address: request.params![0].address,
                  fromBlock,
                  toBlock,
                },
              ],
            });

            logs.push(...(_logs as RpcLog[]));
          }

          return logs;
        }

        if (shouldRetry(error) === false || i === 3) throw error;

        await wait(250 * 2 ** i);
      }
    }
  };

  const requestQueue: Queue<
    unknown,
    {
      request: EIP1193Parameters<PublicRpcSchema>;
      stopClockLag: () => number;
    }
  > = createQueue({
    frequency: network.maxRequestsPerSecond,
    concurrency: Math.ceil(network.maxRequestsPerSecond / 4),
    initialStart: true,
    browser: false,
    worker: async (task: {
      request: EIP1193Parameters<PublicRpcSchema>;
      stopClockLag: () => number;
    }) => {
      common.metrics.ponder_rpc_request_lag.observe(
        { method: task.request.method, network: network.name },
        task.stopClockLag(),
      );

      return await fetchRequest(task.request);
    },
  });

  return {
    ...requestQueue,
    request: <TParameters extends EIP1193Parameters<PublicRpcSchema>>(
      params: TParameters,
    ) => {
      const stopClockLag = startClock();

      return requestQueue.add({ request: params, stopClockLag });
    },
  } as RequestQueue;
};

/**
 * @link https://github.com/wevm/viem/blob/main/src/utils/buildRequest.ts#L192
 */
function shouldRetry(error: Error) {
  if ("code" in error && typeof error.code === "number") {
    if (error.code === -1) return true; // Unknown error
    if (error.code === LimitExceededRpcError.code) return true;
    if (error.code === InternalRpcError.code) return true;
    return false;
  }
  if (error instanceof HttpRequestError && error.status) {
    // Forbidden
    if (error.status === 403) return true;
    // Request Timeout
    if (error.status === 408) return true;
    // Request Entity Too Large
    if (error.status === 413) return true;
    // Too Many Requests
    if (error.status === 429) return true;
    // Internal Server Error
    if (error.status === 500) return true;
    // Bad Gateway
    if (error.status === 502) return true;
    // Service Unavailable
    if (error.status === 503) return true;
    // Gateway Timeout
    if (error.status === 504) return true;
    return false;
  }
  return true;
}
