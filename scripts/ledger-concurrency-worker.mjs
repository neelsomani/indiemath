import { parentPort, workerData } from "node:worker_threads";
import { openLedger } from "#indiemath/ledger";

const ledger = await openLedger({
  databasePath: workerData.databasePath,
  clock: () => new Date(workerData.now),
});

parentPort.postMessage({ type: "ready" });
parentPort.once("message", (message) => {
  if (message !== "go") return;
  try {
    const result = ledger[workerData.operation](workerData.arguments);
    parentPort.postMessage({ type: "result", ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      type: "result",
      ok: false,
      error: {
        name: error.name,
        code: error.code,
        message: error.message,
      },
    });
  } finally {
    ledger.close();
    parentPort.close();
  }
});
