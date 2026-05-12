import { useEffect, useState } from "react";

let deferredPrompt: any;

export default function InstallPrompt() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault();
      deferredPrompt = e;
      setShow(true);
    };

    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="fixed bottom-4 left-0 right-0 flex justify-center z-50">
      <div className="bg-[#020617] border border-slate-800 rounded-2xl p-4 w-[90%] max-w-md shadow-xl">

        <h3 className="text-white text-sm font-semibold">
          Install AQUIPLEX 🚀
        </h3>

        <p className="text-slate-400 text-xs mt-1">
          Faster access. App-like experience.
        </p>

        <div className="flex gap-2 mt-3">
          <button
            onClick={handleInstall}
            className="flex-1 bg-blue-500 hover:bg-blue-600 text-white text-sm py-2 rounded-lg"
          >
            Install
          </button>

          <button
            onClick={() => setShow(false)}
            className="flex-1 border border-slate-700 text-slate-400 text-sm py-2 rounded-lg"
          >
            Not now
          </button>
        </div>

      </div>
    </div>
  );
}