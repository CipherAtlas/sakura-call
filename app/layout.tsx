import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import "./paper.css";

export const metadata: Metadata = {
  title: "Sakura Call",
  description: "Private audio and video calls for up to six people, with screen sharing and translated captions.",
  icons: {
    icon: "/icon.png",
    apple: "/icon.png"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
};

const themeInitScript = `
(() => {
  try {
    const storedTheme = window.localStorage.getItem("sakura.theme");
    const theme =
      storedTheme === "light" || storedTheme === "dark" || storedTheme === "system"
        ? storedTheme
        : "light";
    const darkScheme =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolvedTheme =
      theme === "system"
        ? darkScheme
          ? "dark"
          : "light"
        : theme;

    document.documentElement.dataset.sakuraTheme = resolvedTheme;
    document.documentElement.dataset.sakuraThemePreference = theme;
    document.documentElement.style.colorScheme = resolvedTheme;
  } catch {
  }
})();
`;

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Script
          id="sakura-theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
        {children}
      </body>
    </html>
  );
}
