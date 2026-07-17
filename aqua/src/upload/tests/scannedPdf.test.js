/**
 * Scanned-PDF OCR fallback test (P0 — "PDFs are sometimes unreadable")
 *
 * Fixtures are two real single-page PDFs, embedded as base64:
 *   TEXT_PDF — normal PDF with a text layer ("quarterly revenue…")
 *   SCAN_PDF — image-only PDF (a rendered PNG placed on the page): pdf-parse
 *              extracts NOTHING but the page marker "-- 1 of 1 --", which is
 *              non-empty — exactly the case the old code attached silently.
 *
 * The Gemini call is injected (opts.ocr) so the routing decision, the
 * normalized output, and every failure message are tested deterministically
 * without keys or network.
 *
 * Run: node --test src/upload/tests/scannedPdf.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { processDocument } from "../documentPipeline.js";

const TEXT_PDF = Buffer.from("JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNiAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDYgMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9BdXRob3IgKGFub255bW91cykgL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MDcxNzAzMTcxMSswMCcwMCcpIC9DcmVhdG9yIChhbm9ueW1vdXMpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDI2MDcxNzAzMTcxMSswMCcwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0ICh1bnNwZWNpZmllZCkgL1RpdGxlICh1bnRpdGxlZCkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Db3VudCAxIC9LaWRzIFsgMyAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2RlIC9GbGF0ZURlY29kZSBdIC9MZW5ndGggMTgyCj4+CnN0cmVhbQpHYXJXMFltUz81JjRIRENgS1kqTERlJF5ISm1yL2BYPDJFJDw9JC4qWSc2JCtdZVFkck9GXmdXKmZqXypkKlNUa2VyOUVqNVQwPihiMHE/Q2ErZmZXVl86Wl5AJ3FoIUxXTjxWZzdwV3QkM1lWWT5eUkVbMV1kPTpBJic8bSVBSXRNUHVhPiVrbklCUkJFKzNTOzBhLVFnZi5WJDFZYkZCTzBLQSFuPyhvWUlSUWZhW18iRiJ+PmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDYxIDAwMDAwIG4gCjAwMDAwMDAwOTIgMDAwMDAgbiAKMDAwMDAwMDE5OSAwMDAwMCBuIAowMDAwMDAwNDAyIDAwMDAwIG4gCjAwMDAwMDA0NzAgMDAwMDAgbiAKMDAwMDAwMDczMSAwMDAwMCBuIAowMDAwMDAwNzkwIDAwMDAwIG4gCnRyYWlsZXIKPDwKL0lEIApbPDg3MDBhZTRjMGU5MzE0NDQ1NjRiMDUzMzNkZWQ2OTA2Pjw4NzAwYWU0YzBlOTMxNDQ0NTY0YjA1MzMzZGVkNjkwNj5dCiUgUmVwb3J0TGFiIGdlbmVyYXRlZCBQREYgZG9jdW1lbnQgLS0gZGlnZXN0IChvcGVuc291cmNlKQoKL0luZm8gNSAwIFIKL1Jvb3QgNCAwIFIKL1NpemUgOAo+PgpzdGFydHhyZWYKMTA2MgolJUVPRgo=", "base64");
const SCAN_PDF = Buffer.from("JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0JpdHNQZXJDb21wb25lbnQgOCAvQ29sb3JTcGFjZSAvRGV2aWNlUkdCIC9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXSAvSGVpZ2h0IDQwMCAvTGVuZ3RoIDI1MTYgL1N1YnR5cGUgL0ltYWdlIAogIC9UeXBlIC9YT2JqZWN0IC9XaWR0aCA2MDAKPj4Kc3RyZWFtCkdiIjBVPkd0UVApP0FcIzVuWyo+Lm5iOkdZakNBTzFjPXJOXlA4VypRQWVfOytzW2RoL0hrSTcpaihsIjpSNTRBZE9zN25ec0hyXFYrX3QxNm1fR2Y6bVJQWjhtWSs/ZkQwRjVAJUJJNDtFOFxVQCxMXl8pIlhBQE5dRypfMGBMbU8yLTZhW3p6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enohPDVEaltyKjNLR106RUhyPDxdTG9ZVjIoNnRIO3BxLUNSUmwuYF05TF8xazAsXks6U1tpNzhESSxyQTJbIUJuUmY+TGc7RGk1QV8vZmVsWVVyZ0NOcD1hO2NqW15CSFgmbEtZJFEjK2lsSSpBalFuZFdsR01eSFgpI3M8c2dNOlM/XTY8U3FVSVVBaT8qbjlCSzc1OkZXXTZnQEtibihqcnFsL1ZJZXI9ImkvLzciQFFZQU1qMlszVnJVZkkwWlhxPUdDJSRsbC1STVRZZlh1TSQjNE1CMjA+Q2JsVWZvbixVM3RUSlFeSDEzRm1GcSorI240SWFILlFiYmZHbmtvQjNNaF8xTE9XSFsiYylDIjk0YHE4ZWFJOlE/SlpxUylqcE1xO1dMQDBHTScmZSFhOUsqUzBWRlFxNUJSW1gqTHFZcEhqVDA3TlosK2o7V2ZtaikqbnJdXDpOTEUlWkhESSU7KTJpUjtYKSQ9aWMndCZaMm4zc2lTM0Q/XjAoZE9dKnUwISJsdHVedHAjRiZPOTlFL046Pkw2XlhYZEpVTi5qPWA6P2M2XU0+JDViWDdQbDMtPDIkYDJKKCRxbiVTWzptYkc/NW8nPEtvN1pNOThYUCJtRFYyS08qWlkuVFptMjVZZ0RuXkxSTT5xZWldWF9PbU5rPV9qWCpCJElkWDsmaWtMIys7LV9HY0EpRm9pME5QLCk9P1txSiJeJiw3bURUYlBpKkNbTz9MbV5IdWJWTjw7IVAiVFJJLlBWW3A/ZGRYcT1FYy5DdEs7QWAyNjd1byVxRC9JbHVgPDMtNDYrXmp1VSZyViMhTkEma0hQWW85ZktaUi9gKV1RcjFUSzFoUCRbVlhWMGFmRHFQQFctYnFxLkk8X21KY25ATyhkLnFlUDJTcTI5LEBfZjNkXmkyZkBDZlxLRHUkRCxRX0dLMkZSVXFXWHA+T1VqXFNZbCdfcGpNSFRZU05EJnBxPCtDIWsyRjQ1TWNaPCZCMjUza05NOy9lXXUsVTluJ2UxMV1MRyEnR089KiFEb0VgQGghdDcsWT8tLDtubikucF0nSE1XPCNaWDVnK1g9aGYzYSNVXUxEKEVDPlphUjFhO21wZ1BpWihcRGAvXUVgWzdHVDc2VmMpRis1cmouMUROSCVjaVxYMyY1NCRaRVdAVlRHI0xKKzpKb1ouWiFLUyk4X3FdbS8wV1Q3JDRwWDA1IWZDWSxgUGNDSEthXWMnQ3E4Z2NPPEdMYl43YXMzJTk+LiYqRmdmOkpjI25uWTVxO21zakdqTV1VQFRWbUhYYWc2OFtzV00vLEVlK2syUTpHOkU4bmZtOylFRmFoRUAkTnFCZG8hb3RVWT9QYjFqNEtdVUNEOCE6UlA8RGsqPm5GIXBXN08pNF1JZV9rQU5zW0xXODwrY1YqaypPNEhjVltSIltEZT9LOT1jWzE2IyElYTxRYkFHU0lnXEd0JGNSTyRATiRtXDMuLmlqNnEiT1lOViVOKDFJV3ItME0iSj8tbUleXGd1Nj5NSERtYTYwJUAvb2tGP1BTJ21nO2w8Q2JoS3MvXDpnW1I6cUtrKStdNjgkajFvM1AkLmBUWV1OKF5RX3ElQSxMbStKZ2FnWkhjKHA5bk1SUCQsLCc3M2E6SC1rJSdVXzw8SWs/VHUzWFVsJU4zVS1PMWZOQW1HVGxEXy0ua0prRz05cEBbaTdadGpFOykxKT85IXBidUBucmVWZkNIIWA4VCJKKXEobFsvQ3RjNzFgPypJM0hoSFk9YEYnQ0NuXjBgbzoqMylLaTRzbyJvXXQrSW1iR0E3Ujs7aiVyREQ+ajRhSnFUaj9fXUcvc2FHOClgUW8mPCtON3NEci8sZTc0cWlUbkU/WC5RN2RYImYhQiM4J1Q8cVU0WyJyRWs/KVpTWEJBSydxbDdXQW8jU0NibFw1b2w/SkpQX1toQyxhNm1nV3JELUpLQSJxO0s4LVBGL2lsRGwncUw2VGonYWw5KkclT2plNG0qTUZua0tdVkMyYS1dTCcrb05pclYoNkZyVXVJLilgO0BFPSJIaSNZZGhXTTs1OSFoPGgiPnVIUFEvMWQlTmZPJWohaVgwYFVdR1hXRGxPUHVsRC8yPSZrdCsjQE5RVWUtYkpyNUJJWjlKdV8oXW1LQFtjKTQ9LV0pMXAtb0Q9WEU/NTMwaTQqS3NtZTRvMydha2FSUUdPKmlJSytDLyVTPERJZGBKWU9uKyRbSl1FTEJPXj5FZ2M+Om1gPDJhSyc9SW1HNUJ1MGxwP1FCL3BTLkJkQythME1KSEQqYzAyLWtoai4pUFxlTy8vVzk+JjxOQlRGOlojVFhrQEUibiwzZWxbUEgkVTwsXGpTZG8yRT4qRDlUdT9mV2Vwck9CNkhwLGUwZVQtOzlmcmhMIl8xQiJVU3BhJzV1ZykmJWpxWnVQLUcnbW4ja0U+cmxzclYmZ0o1Q2BcMWwtbFBLXV5gdVVPLjk8Ujx1NmpgX1J0MGM4ZitnYCRucGI3NDUkclE6WygqOUpWZE46QDBHTSdaPTplMWE/YFs/JTMuP0hrS11WMUgyZFgmVUJIQkQ5aGU+LWIocmBcMlFjbWNjPCw+K3E8IjE7YEhmN0whVm02MGVgLFt0NjliOzVaX2F1LTlnbV0tXkxxKm1aWStRJStWczZWWUl1akZzMFQ9RV8xRjpGXHRvQCNqRjpWIWR1MEVpMzJDKi1QVVdZN1k+MidtSlNLSGFkVDBWYUdeUkovN1o4MD1Fb2I6aVpBJmYtZXUpPDlHV2cwNDpsYGtuNFplUEdMRTphaW5sajJscFk5aTk5LyF0WGxuSWohRFJua3BXIVslVzs4QnA9ZWxzUkVLOEkmb2BZOChRa3B0JDRnPWlEdVMjMlVuLSRKWS1Pb0NAIkloTWhbIiVBJkoxITlZIXp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6eiEhISM3czQ+IWRVKi9gRX4+ZW5kc3RyZWFtCmVuZG9iago0IDAgb2JqCjw8Ci9Db250ZW50cyA4IDAgUiAvTWVkaWFCb3ggWyAwIDAgNTk1LjI3NTYgODQxLjg4OTggXSAvUGFyZW50IDcgMCBSIC9SZXNvdXJjZXMgPDwKL0ZvbnQgMSAwIFIgL1Byb2NTZXQgWyAvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJIF0gL1hPYmplY3QgPDwKL0Zvcm1Yb2IuYWJiNmJlOWFkOTc4NGY2OTc4NmRhZGZiZmM2NzRlNTEgMyAwIFIKPj4KPj4gL1JvdGF0ZSAwIC9UcmFucyA8PAoKPj4gCiAgL1R5cGUgL1BhZ2UKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1BhZ2VNb2RlIC9Vc2VOb25lIC9QYWdlcyA3IDAgUiAvVHlwZSAvQ2F0YWxvZwo+PgplbmRvYmoKNiAwIG9iago8PAovQXV0aG9yIChhbm9ueW1vdXMpIC9DcmVhdGlvbkRhdGUgKEQ6MjAyNjA3MTcwMzE3MjMrMDAnMDAnKSAvQ3JlYXRvciAoYW5vbnltb3VzKSAvS2V5d29yZHMgKCkgL01vZERhdGUgKEQ6MjAyNjA3MTcwMzE3MjMrMDAnMDAnKSAvUHJvZHVjZXIgKFJlcG9ydExhYiBQREYgTGlicmFyeSAtIFwob3BlbnNvdXJjZVwpKSAKICAvU3ViamVjdCAodW5zcGVjaWZpZWQpIC9UaXRsZSAodW50aXRsZWQpIC9UcmFwcGVkIC9GYWxzZQo+PgplbmRvYmoKNyAwIG9iago8PAovQ291bnQgMSAvS2lkcyBbIDQgMCBSIF0gL1R5cGUgL1BhZ2VzCj4+CmVuZG9iago4IDAgb2JqCjw8Ci9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXSAvTGVuZ3RoIDEzNAo+PgpzdHJlYW0KR2FvZTNdYURZMiRqTG89YFYwTGwnR1JCSDZeK0tCXypfO0lOXTFJcnBFL3REXzgzcW9wZC0lIiQ3bDVWLUJKOCU1ZFhJQyYoV3VOLkolVGlgWV1TO1ZGcGc8cnE0bVVNc2ZhKSo6bDsrWytKczUwYylMYi1KXzIuXT91czEtXS5VOmE4fj5lbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA5CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA2MSAwMDAwMCBuIAowMDAwMDAwMDkyIDAwMDAwIG4gCjAwMDAwMDAxOTkgMDAwMDAgbiAKMDAwMDAwMjkwNiAwMDAwMCBuIAowMDAwMDAzMTcyIDAwMDAwIG4gCjAwMDAwMDMyNDAgMDAwMDAgbiAKMDAwMDAwMzUwMSAwMDAwMCBuIAowMDAwMDAzNTYwIDAwMDAwIG4gCnRyYWlsZXIKPDwKL0lEIApbPGVhZGEzYjU0MzU1ZGFjZGZiYzY0ZTFjMzgxODU2ZjUwPjxlYWRhM2I1NDM1NWRhY2RmYmM2NGUxYzM4MTg1NmY1MD5dCiUgUmVwb3J0TGFiIGdlbmVyYXRlZCBQREYgZG9jdW1lbnQgLS0gZGlnZXN0IChvcGVuc291cmNlKQoKL0luZm8gNiAwIFIKL1Jvb3QgNSAwIFIKL1NpemUgOQo+PgpzdGFydHhyZWYKMzc4NAolJUVPRgo=", "base64");

const OCR_TEXT = "TITLE: Scanned Invoice\n\nTEXT (OCR): -- Page 1 --\nSCANNED INVOICE #4471 total Rs 92,000\n\nTABLES: none\n\nNOTES: none";

test("PDF with a text layer parses normally — OCR is never called", async () => {
  let ocrCalls = 0;
  const doc = await processDocument("report.pdf", TEXT_PDF, {
    ocr: async () => { ocrCalls++; throw new Error("must not be called"); },
  });
  assert.equal(ocrCalls, 0);
  assert.match(doc.content, /quarterly revenue/);
  assert.equal(doc.pages, 1);
  assert.ok(!doc.metadata.ocr, "text-layer PDFs are not marked as OCR output");
});

test("scanned PDF routes to OCR and returns the transcription, not page markers", async () => {
  let seenParts = null;
  const doc = await processDocument("scan.pdf", SCAN_PDF, {
    ocr: async (parts) => { seenParts = parts; return { text: OCR_TEXT, model: "fake-vision" }; },
  });
  assert.ok(seenParts, "OCR fallback must fire for a marker-only PDF");
  assert.equal(seenParts[0].inlineData.mimeType, "application/pdf", "whole PDF goes to vision inline");
  assert.match(doc.content, /INVOICE #4471/, "attachment carries real OCR text");
  assert.equal(doc.metadata.ocr, true);
  assert.equal(doc.metadata.model, "fake-vision");
  assert.ok(doc.sections.length >= 1, "OCR output still gets section structure");
});

test("scanned PDF with OCR unavailable fails LOUDLY with a user-readable reason", async () => {
  // unique bytes → cache miss → the failure path actually runs
  const SCAN_PDF_B = Buffer.concat([SCAN_PDF, Buffer.from(" B")]);
  await assert.rejects(
    processDocument("scan.pdf", SCAN_PDF_B, {
      ocr: async () => { throw new Error("No Gemini keys configured — media analysis unavailable"); },
    }),
    /scanned PDF.*OCR failed.*No Gemini keys/s,
    "the old behavior (silently attaching page markers) must be impossible",
  );
});

test("scanned PDF over the OCR size cap is rejected with guidance, before any model call", async () => {
  let ocrCalls = 0;
  const big = Buffer.concat([SCAN_PDF, Buffer.alloc(12_000_001)]);
  await assert.rejects(
    processDocument("huge-scan.pdf", big, { ocr: async () => { ocrCalls++; return { text: "x" }; } }),
    /OCR limit/,
  );
  assert.equal(ocrCalls, 0);
});

test("identical scanned PDF re-upload is served from the OCR cache — zero model calls", async () => {
  const SCAN_PDF_C = Buffer.concat([SCAN_PDF, Buffer.from(" C")]);
  let ocrCalls = 0;
  const first = await processDocument("scan.pdf", SCAN_PDF_C, {
    ocr: async () => { ocrCalls++; return { text: OCR_TEXT, model: "fake-vision" }; },
  });
  assert.equal(ocrCalls, 1);
  // Second upload of the SAME bytes: OCR fn would throw — must never be reached.
  const second = await processDocument("scan-again.pdf", SCAN_PDF_C, {
    ocr: async () => { throw new Error("model must not be called on a cache hit"); },
  });
  assert.equal(second.content, first.content, "cache returns the identical transcription");
  assert.equal(second.metadata.ocr, true);
});
