import { useEffect, useState } from "react";
import type qrcodeGenerator from "qrcode-generator";

type QrFactory = typeof qrcodeGenerator;

// The encoder is only needed by the 2FA setup screen: loaded on first use, not with the app.
let factory: QrFactory | null = null;
const loadFactory = () => import("qrcode-generator").then(m => (factory = m.default));

/** A QR code drawn as SVG squares (qrcode-generator, MIT). The data never becomes markup. */
export function QrCode({ data, label }: { data: string; label: string }) {
  const [qrcode, setQrcode] = useState<QrFactory | null>(factory);
  useEffect(() => {
    // The factory is a function: wrap it so setState does not call it as an updater.
    if (!qrcode) void loadFactory().then(f => setQrcode(() => f));
  }, [qrcode]);
  if (!qrcode) return <svg viewBox="0 0 1 1" role="img" aria-label={label} aria-busy="true" />;
  const qr = qrcode(0, "M");
  qr.addData(data);
  qr.make();
  const count = qr.getModuleCount();
  const cells: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) if (qr.isDark(row, col)) cells.push(`M${col} ${row}h1v1h-1z`);
  }
  return (
    <svg viewBox={`-2 -2 ${count + 4} ${count + 4}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <path d={cells.join("")} fill="#000" />
    </svg>
  );
}
