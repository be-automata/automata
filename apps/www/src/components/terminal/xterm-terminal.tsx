"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Terminal } from "xterm";
import type { FitAddon } from "xterm-addon-fit";
import "@xterm/xterm/css/xterm.css";
import "@/styles/xterm-override.css";
import { useTheme } from "next-themes";
import { DARK_THEME_COLORS, LIGHT_THEME_COLORS } from "@/lib/ansi-colors";

export interface XtermTerminalHandle {
  write: (data: string) => void;
  writeln: (data: string) => void;
  writeMessage: (data: string) => void;
  clear: () => void;
  focus: () => void;
  blur: () => void;
  getSelection: () => string | undefined;
  cols: () => number | undefined;
  rows: () => number | undefined;
  fit: () => void;
}

export interface XtermTerminalProps {
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  disabled?: boolean;
  className?: string;
}

export const XtermTerminal = forwardRef<
  XtermTerminalHandle,
  XtermTerminalProps
>(({ onData, onResize, disabled = false, className = "" }, ref) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const dataDisposableRef = useRef<any>(null);
  const instanceId = useRef(`xterm-${Date.now()}-${Math.random()}`).current;
  const { resolvedTheme } = useTheme();
  const isInitializedRef = useRef(false);

  useEffect(() => {
    if (!terminalRef.current || isInitializedRef.current) {
      return;
    }

    // Mark as initialized immediately to prevent double initialization
    isInitializedRef.current = true;

    // Dynamically import xterm to avoid SSR issues
    const initTerminal = async () => {
      const { Terminal } = await import("xterm");
      const { FitAddon } = await import("xterm-addon-fit");
      const { WebLinksAddon } = await import("xterm-addon-web-links");

      // Double-check terminal element is still available
      if (!terminalRef.current) {
        return;
      }

      // Clear any existing terminal content to prevent duplicates
      terminalRef.current.innerHTML = "";

      // Initialize xterm with fallback dimensions
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        // Not TX-02: its licence excludes terminals. Canvas needs a resolved
        // family name, so read next/font's Geist Mono variable.
        fontFamily:
          getComputedStyle(document.body)
            .getPropertyValue("--font-geist-mono")
            .trim() || "monospace",
        cols: 80, // Default columns
        rows: 24, // Default rows
        theme:
          resolvedTheme === "dark" ? DARK_THEME_COLORS : LIGHT_THEME_COLORS,
      });

      // Add addons
      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);

      // Open terminal in DOM
      terminal.open(terminalRef.current);

      // Store refs
      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // Fit after terminal is ready and DOM is settled
      requestAnimationFrame(() => {
        setTimeout(() => {
          try {
            if (
              fitAddonRef.current &&
              xtermRef.current &&
              terminalRef.current
            ) {
              // Check if terminal has valid dimensions
              const dimensions = (xtermRef.current as any)._core?._renderService
                ?.dimensions;
              if (
                dimensions &&
                dimensions.actualCellWidth &&
                dimensions.actualCellHeight
              ) {
                fitAddon.fit();
              } else {
                console.warn(
                  "Terminal dimensions not ready, will fit on next resize",
                );
              }
            }
          } catch (e) {
            console.warn("Initial fit failed, will retry on resize", e);
          }
        }, 0);
      });

      // Handle window resize
      const handleResize = () => {
        try {
          if (fitAddonRef.current && xtermRef.current && terminalRef.current) {
            fitAddonRef.current.fit();
          }
        } catch (e) {
          console.warn("Fit failed on resize", e);
        }
      };
      window.addEventListener("resize", handleResize);

      // Handle container resize with ResizeObserver
      const resizeObserver = new ResizeObserver((entries) => {
        // Only handle resize if the terminal container has actual size
        const entry = entries[0];
        if (
          entry &&
          entry.contentRect.width > 0 &&
          entry.contentRect.height > 0
        ) {
          handleResize();
        }
      });
      resizeObserver.observe(terminalRef.current);

      return () => {
        window.removeEventListener("resize", handleResize);
        resizeObserver.disconnect();
        // Ensure terminal is properly disposed
        if (xtermRef.current) {
          xtermRef.current.dispose();
          xtermRef.current = null;
        }
        if (fitAddonRef.current) {
          fitAddonRef.current = null;
        }
        // Clear the container to prevent orphaned DOM elements
        if (terminalRef.current) {
          terminalRef.current.innerHTML = "";
        }
        // Reset initialization flag for potential re-mount
        isInitializedRef.current = false;
      };
    };

    initTerminal();
  }, [resolvedTheme]);

  // Handle data input
  useEffect(() => {
    if (!xtermRef.current) return;

    const terminal = xtermRef.current;

    // Clean up previous handler
    if (dataDisposableRef.current) {
      dataDisposableRef.current.dispose();
      dataDisposableRef.current = null;
    }

    // Update stdin state when disabled prop changes
    terminal.options.disableStdin = disabled;

    // Set up new handler if enabled and onData is provided
    if (!disabled && onData) {
      dataDisposableRef.current = terminal.onData(onData);
    }

    return () => {
      if (dataDisposableRef.current) {
        dataDisposableRef.current.dispose();
        dataDisposableRef.current = null;
      }
    };
  }, [disabled, onData]);

  useEffect(() => {
    if (!xtermRef.current) return;
    xtermRef.current.options.theme =
      resolvedTheme === "dark" ? DARK_THEME_COLORS : LIGHT_THEME_COLORS;
  }, [resolvedTheme]);

  // Handle resize events
  useEffect(() => {
    if (!xtermRef.current || !onResize) return;

    const terminal = xtermRef.current;

    // Set up resize handler with debounce
    let resizeTimeout: NodeJS.Timeout;
    const disposable = terminal.onResize((size) => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        onResize(size.cols, size.rows);
      }, 300); // Debounce resize events
    });

    return () => {
      clearTimeout(resizeTimeout);
      disposable.dispose();
    };
  }, [onResize]);

  // Expose terminal methods via ref
  useImperativeHandle(
    ref,
    () => ({
      write: (data: string) => xtermRef.current?.write(data),
      writeln: (data: string) => xtermRef.current?.writeln(data),
      writeMessage: (data: string) => {
        if (xtermRef.current?.buffer.active.cursorX !== 0) {
          xtermRef.current?.writeln("");
        }
        // Muted text
        xtermRef.current?.writeln(`\x1b[2m${data}\x1b[0m`);
      },
      clear: () => xtermRef.current?.clear(),
      focus: () => xtermRef.current?.focus(),
      blur: () => xtermRef.current?.blur(),
      getSelection: () => xtermRef.current?.getSelection(),
      cols: () => xtermRef.current?.cols,
      rows: () => xtermRef.current?.rows,
      fit: () => {
        try {
          fitAddonRef.current?.fit();
        } catch (e) {
          console.warn("Failed to fit terminal", e);
        }
      },
    }),
    [],
  );

  return (
    <div
      ref={terminalRef}
      className={`xterm-container ${className || ""}`}
      data-terminal-instance={instanceId}
      onClick={() => xtermRef.current?.focus()}
      style={{
        cursor: "text",
        height: "100%",
        width: "100%",
        position: "relative",
      }}
    />
  );
});

XtermTerminal.displayName = "XtermTerminal";
