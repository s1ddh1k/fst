export type UpbitTickerMessage = {
  type: string;
  code: string;
  trade_price: number;
  trade_volume: number;
  timestamp: number;
  stream_type: string;
};

export async function streamTickers(params: {
  marketCodes: string[];
  onMessage: (message: UpbitTickerMessage) => Promise<void> | void;
  maxEvents?: number;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let handledEvents = 0;
    const websocket = new WebSocket("wss://api.upbit.com/websocket/v1");

    websocket.addEventListener("open", () => {
      websocket.send(
        JSON.stringify([
          {
            ticket: `paper-trader-${Date.now()}`
          },
          {
            type: "ticker",
            codes: params.marketCodes,
            is_only_realtime: true
          },
          {
            format: "DEFAULT"
          }
        ])
      );
    });

    websocket.addEventListener("message", async (event: MessageEvent<string | Blob | ArrayBuffer>) => {
      try {
        const text =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof ArrayBuffer
              ? Buffer.from(event.data).toString("utf8")
              : Buffer.from(await event.data.arrayBuffer()).toString("utf8");
        const parsed = JSON.parse(text) as UpbitTickerMessage;
        await params.onMessage(parsed);
        handledEvents += 1;

        if (params.maxEvents && handledEvents >= params.maxEvents) {
          websocket.close();
        }
      } catch (error) {
        websocket.close();
        reject(error);
      }
    });

    websocket.addEventListener("close", () => resolve());
    websocket.addEventListener("error", (error: Event) => reject(error));
  });
}

export async function streamTicker(params: {
  marketCode: string;
  onMessage: (message: UpbitTickerMessage) => Promise<void> | void;
  maxEvents?: number;
}): Promise<void> {
  await streamTickers({
    marketCodes: [params.marketCode],
    onMessage: params.onMessage,
    maxEvents: params.maxEvents
  });
}
