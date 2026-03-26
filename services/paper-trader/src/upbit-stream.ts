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
    let busy = false;
    const websocket = new WebSocket("wss://api.upbit.com/websocket/v1");

    websocket.addEventListener("open", () => {
      process.stderr.write(`[stream] connected, subscribing to ${params.marketCodes.length} markets\n`);
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
      if (busy) return;
      busy = true;
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
      } finally {
        busy = false;
      }
    });

    websocket.addEventListener("close", () => { process.stderr.write("[stream] disconnected\n"); resolve(); });
    websocket.addEventListener("error", (error: Event) => { process.stderr.write(`[stream] error: ${String(error)}\n`); reject(error); });
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
