import * as React from "react";
import { Card, CardContent } from "./card";
import { Button } from "./button";

// Last-resort guard: a single malformed record must never blank a whole
// screen. Wrap tab panels / sections with this; on error it shows a
// recoverable fallback instead of an unmounted tree.
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; title?: string },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error("[ui] section failed to render", error);
  }

  override render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <Card>
          <CardContent className="flex flex-col items-start gap-2 p-4">
            <p className="text-sm font-semibold">{this.props.title ?? "Something went wrong"}</p>
            <p className="max-w-[60ch] text-[13px] text-muted-foreground">
              This section could not be displayed. Reloading usually fixes it; if it
              persists, the underlying data needs attention.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                this.setState({ failed: false });
                window.location.reload();
              }}
            >
              Reload page
            </Button>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}
