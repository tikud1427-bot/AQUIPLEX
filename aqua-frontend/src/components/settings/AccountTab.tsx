import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUiStore } from '@/stores/uiStore';
import {
  getAccount,
  deleteAccount,
  startGoogleReauth,
  clearLocalAppData,
  type AccountInfo,
} from '@/api/account';

/** Exactly what the backend erases — shown before the user commits. */
const DELETED_ITEMS = [
  'Your account, profile, and remaining credits',
  'Every conversation and message',
  'Everything Aqua remembers about you',
  'Uploaded files, projects, and anything extracted from them',
  'Artifacts Aqua generated for you',
  'All active sessions — you’ll be signed out everywhere',
];

export function AccountTab() {
  const toast = useUiStore((s) => s.toast);

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setAccount(await getAccount());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Returning from the Google reauthentication round trip: reopen the
  // confirmation the user was already in the middle of, then scrub the marker
  // from the URL so a refresh doesn't reopen it forever.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('deleteReauth');
    if (!outcome) return;

    if (outcome === 'ok') {
      setConfirmOpen(true);
    } else {
      setError("Google couldn't confirm it was you. Try again.");
    }

    params.delete('deleteReauth');
    params.delete('settings');
    const query = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
  }, []);

  const isGoogle = account?.authMethod === 'google';
  const needsGoogleReauth = isGoogle && !account?.reauthFresh;
  const canSubmit = isGoogle ? !!account?.reauthFresh : password.length > 0;

  function openConfirm() {
    setError(null);
    setPassword('');
    setConfirmOpen(true);
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);

    const result = await deleteAccount(isGoogle ? undefined : password);

    if (!result.ok) {
      setDeleting(false);
      setPassword('');
      setError(result.message ?? 'Deletion failed.');
      // An expired or missing Google confirmation means the round trip has to
      // happen again — refresh the account so the button flips back.
      if (result.error === 'REAUTH_EXPIRED' || result.error === 'REAUTH_REQUIRED') {
        void load();
      }
      return;
    }

    // Deleted server-side. Leave nothing on this device, then hand off to the
    // platform's login page — the SPA is gone at this point, so a full
    // navigation (not a router push) is the correct exit.
    await clearLocalAppData();
    toast('success', 'Your account has been deleted');
    window.location.replace('/login');
  }

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-foreground-secondary" />
      </div>
    );
  }

  if (!account) {
    return (
      <p className="py-6 text-center text-sm text-foreground-secondary">
        Couldn’t load your account details. Check your connection and reopen Settings.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-sm font-medium text-foreground">Signed in as</p>
        <div className="flex items-center justify-between rounded-lg border border-border bg-surface-secondary/40 px-3 py-2.5">
          <span className="truncate text-sm text-foreground">{account.email}</span>
          <span className="shrink-0 text-xs text-foreground-secondary">
            {isGoogle ? 'Google account' : 'Email & password'}
          </span>
        </div>
      </div>

      <Separator />

      <div>
        <p className="mb-2 text-sm font-medium text-danger">Danger zone</p>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/20 bg-danger/5 p-3">
          <div className="min-w-0">
            <p className="text-sm text-foreground">Delete account</p>
            <p className="text-xs text-foreground-secondary">
              Permanently deletes your account and all of your data. This cannot be undone.
            </p>
          </div>
          <Button size="sm" variant="destructive" className="shrink-0" onClick={openConfirm}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </div>

        {error && !confirmOpen && (
          <p className="mt-2 text-xs text-danger" role="alert">
            {error}
          </p>
        )}

        <p className="mt-2 text-xs text-foreground-secondary">
          Can’t sign in on another device?{' '}
          <a href="/delete-account" className="underline hover:text-foreground">
            See all deletion options
          </a>
          .
        </p>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(open) => !deleting && setConfirmOpen(open)}>
        <DialogContent className="max-w-md" hideClose>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-danger">
              <AlertTriangle className="h-4 w-4" /> Delete your account permanently?
            </DialogTitle>
            <DialogDescription>
              This is immediate and irreversible. There is no recovery window — once it’s done, we
              cannot restore any of it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <p className="text-xs font-medium text-foreground">What will be deleted</p>
            <ul className="space-y-1.5">
              {DELETED_ITEMS.map((item) => (
                <li key={item} className="flex gap-2 text-xs text-foreground-secondary">
                  <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-danger/60" />
                  {item}
                </li>
              ))}
            </ul>

            <Separator />

            {isGoogle ? (
              account.reauthFresh ? (
                <p className="flex items-center gap-1.5 text-xs text-success">
                  <Check className="h-3.5 w-3.5" /> Confirmed with Google — you can delete now.
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-foreground-secondary">
                    You signed up with Google, so confirm it’s you before deleting.
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full"
                    onClick={() => startGoogleReauth('/aqua?settings=account')}
                  >
                    Confirm with Google
                  </Button>
                </div>
              )
            ) : (
              <div className="space-y-2">
                <label htmlFor="delete-password" className="text-xs text-foreground-secondary">
                  Enter your password to confirm
                </label>
                <Input
                  id="delete-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  disabled={deleting}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canSubmit && !deleting) void handleDelete();
                  }}
                  placeholder="Password"
                />
              </div>
            )}

            {error && (
              <p className="text-xs text-danger" role="alert">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={deleting} onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!canSubmit || deleting || needsGoogleReauth}
              onClick={handleDelete}
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {deleting ? 'Deleting…' : 'Delete forever'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
