/**
 * Worker thread for PDF generation.
 *
 * Collects the full PDF into memory, then posts it as a single buffer back to
 * the parent thread.  This avoids chunked-transfer issues when the app is
 * deployed behind a reverse proxy (e.g. nginx) that buffers or re-frames
 * streaming responses.
 */
const { workerData, parentPort } = require("worker_threads");
const { generateDeckPdf } = require("./utils/pdf-export");

const { deck, symbols, cards } = workerData;
const doc = generateDeckPdf(deck, symbols, cards);
const chunks = [];

doc.on("data", (chunk) => {
  chunks.push(chunk);
});

doc.on("end", () => {
  const pdf = Buffer.concat(chunks);
  parentPort.postMessage({ type: "done", data: pdf }, [pdf.buffer]);
});

doc.on("error", (err) => {
  parentPort.postMessage({ type: "error", message: err.message });
});

doc.end();
