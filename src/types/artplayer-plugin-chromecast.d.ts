declare module '@/lib/artplayer-plugin-chromecast' {
  interface ChromecastPluginOptions {
    icon?: string;
    sdk?: string;
    url?: string;
    mimeType?: string;
    onStateChange?: (state: 'connected' | 'connecting' | 'disconnected' | 'disconnecting') => void;
    onCastAvailable?: (available: boolean) => void;
    onCastStart?: () => void;
    onError?: (error: Error) => void;
  }

  interface ChromecastPlugin {
    name: 'artplayerPluginChromecast';
    getCastState: () => unknown;
    isCasting: () => boolean;
  }

  function artplayerPluginChromecast(options?: ChromecastPluginOptions): (art: unknown) => Promise<ChromecastPlugin>;
  export default artplayerPluginChromecast;
}
