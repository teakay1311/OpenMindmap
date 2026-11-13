import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenMindmap — MindMap App V3.5",
  description:
    "Ứng dụng sơ đồ tư duy offline-first theo đặc tả V3.5: 8 bố cục, nhập 4 / xuất 7 định dạng, Command + Undo/Redo, JSON schema v3.",
  icons: { icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%230D443D'/><path d='M36 50 H52 M52 50 C60 50 58 28 68 28 M52 50 C60 50 60 50 68 50 M52 50 C60 50 58 72 68 72' stroke='%2374D7C5' stroke-width='5' stroke-linecap='round' fill='none'/><rect x='16' y='40' width='22' height='20' rx='10' fill='%23FFF7EB'/><rect x='66' y='20' width='20' height='16' rx='8' fill='%2374D7C5'/><rect x='66' y='42' width='20' height='16' rx='8' fill='%23F6B64B'/><rect x='66' y='64' width='20' height='16' rx='8' fill='%23F08475'/></svg>" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#17635D",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
