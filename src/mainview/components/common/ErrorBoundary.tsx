import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { Button } from "@/components/ui/button";
import { IconArrowsRotate, IconBug } from "@/lib/icons";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-foreground">
          <IconBug className="size-12 text-destructive/60" />
          <h2 className="font-bold text-lg">出现错误</h2>
          <p className="max-w-md text-center text-foreground/60 text-sm">
            {this.state.error?.message || "发生未知错误。"}
          </p>
          <Button variant="default" size="sm" onClick={this.handleReset}>
            <IconArrowsRotate className="size-4" />
            重试
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
