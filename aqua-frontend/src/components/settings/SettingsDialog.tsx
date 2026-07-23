import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { GeneralTab } from './GeneralTab';
import { MemoryTab } from './MemoryTab';
import { ShortcutsTab } from './ShortcutsTab';
import { AccountTab } from './AccountTab';
import { AboutTab } from './AboutTab';
import { useUiStore } from '@/stores/uiStore';

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState('general');

  // Deep link back into this dialog. The Google reauthentication round trip
  // for account deletion is a full-page navigation, so the platform returns
  // the browser to /aqua?settings=account&deleteReauth=… — reopen Settings on
  // the Account tab so the user lands exactly where they left off.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('settings') === 'account' || params.has('deleteReauth')) {
      setTab('account');
      setOpen(true);
    }
  }, [setOpen]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="account">Account</TabsTrigger>
            <TabsTrigger value="shortcuts">Shortcuts</TabsTrigger>
            <TabsTrigger value="about">About</TabsTrigger>
          </TabsList>

          <TabsContent value="general">
            <GeneralTab />
          </TabsContent>
          <TabsContent value="memory">
            <MemoryTab />
          </TabsContent>
          <TabsContent value="account">
            <AccountTab />
          </TabsContent>
          <TabsContent value="shortcuts">
            <ShortcutsTab />
          </TabsContent>
          <TabsContent value="about">
            <AboutTab />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
