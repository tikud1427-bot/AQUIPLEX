import * as React from 'react';
import { AlertOctagon } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  children: React.ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('AQUA render error:', error, info.componentStack);
    // P0 (cache) — a failed dynamic import mid-render is the stale-deploy
    // signature (old shell asking for deleted chunks). One automatic reload
    // fetches the fresh build; the sessionStorage mark prevents loops.
    if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(error.message)) {
      try {
        const mark = 'aqua-boundary-reloaded';
        if (!sessionStorage.getItem(mark)) {
          sessionStorage.setItem(mark, '1');
          window.location.reload();
        }
      } catch {
        window.location.reload();
      }
    }
  }

  handleReset = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-background px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-danger/10">
            <AlertOctagon className="h-6 w-6 text-danger" />
          </div>
          <div className="space-y-1">
            <h1 className="text-base font-semibold text-foreground">Something broke on our end</h1>
            <p className="max-w-sm text-sm text-foreground-secondary">
              AQUA hit an unexpected error. Reloading usually fixes it — your conversations are saved on the server.
            </p>
          </div>
          <Button onClick={this.handleReset}>Reload AQUA</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
