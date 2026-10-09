"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/** Client wrapper for next-themes so the root layout can stay a server
 *  component. The layout forces dark: the app has no light palette. */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
