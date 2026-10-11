import qrcode from "qrcode-generator";

/** A QR code drawn as SVG squares (qrcode-generator, MIT). The data never becomes markup. */
export function QrCode({ data, label }: { data: string; label: string }) {
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
