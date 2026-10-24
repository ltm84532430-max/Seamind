import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import type { WebPoSignalOutput } from 'bgutils-js/shared-types';

interface SnapshotRequest {
  requestId: string;
  contentBinding: string;
  challenge: {
    globalName: string;
    program: string;
    interpreterHash?: string;
  };
  ytConfig?: Record<string, unknown>;
}

interface MintRequest {
  requestId: string;
  contentBinding: string;
  integrityToken: string;
}

interface RuntimeResult {
  requestId: string;
  ok: boolean;
  botguardResponse?: unknown;
  token?: string;
  error?: string;
}

interface RuntimeWindow extends Window {
  __seamindBotGuardSnapshot?: (request: SnapshotRequest) => void;
  __seamindBotGuardMint?: (request: MintRequest) => void;
  __seamindBotGuardResult?: RuntimeResult | null;
  yt?: Record<string, unknown>;
}

const runtimeWindow = window as RuntimeWindow;
const sessions = new Map<
  string,
  {
    signals: WebPoSignalOutput;
    previousYt?: Record<string, unknown>;
    changedYt: boolean;
  }
>();

function isYouTubeOrigin() {
  const { protocol, hostname } = runtimeWindow.location;
  return (
    protocol === 'https:' &&
    (hostname === 'youtube.com' || hostname.endsWith('.youtube.com'))
  );
}

function restoreYt(session: {
  previousYt?: Record<string, unknown>;
  changedYt: boolean;
}) {
  if (!session.changedYt) return;
  if (session.previousYt) runtimeWindow.yt = session.previousYt;
  else delete runtimeWindow.yt;
}

function publishResult(result: RuntimeResult) {
  runtimeWindow.__seamindBotGuardResult = result;
}

if (isYouTubeOrigin()) {
  runtimeWindow.__seamindBotGuardSnapshot = (request) => {
    runtimeWindow.__seamindBotGuardResult = null;
    void (async () => {
      const previousYt = runtimeWindow.yt;
      const changedYt = Boolean(request.ytConfig);
      if (changedYt)
        runtimeWindow.yt = { ...previousYt, config_: request.ytConfig };
      try {
        const botguard = await BotGuardClient.create({
          globalObject: runtimeWindow,
          globalName: request.challenge.globalName,
          program: request.challenge.program,
        });
        const webPoSignalOutput: WebPoSignalOutput = [];
        const botguardResponse = await botguard.snapshot(
          { webPoSignalOutput },
          10_000,
        );
        sessions.set(request.requestId, {
          signals: webPoSignalOutput,
          previousYt,
          changedYt,
        });
        publishResult({
          requestId: request.requestId,
          ok: true,
          botguardResponse,
        });
      } catch (error) {
        const session = sessions.get(request.requestId);
        if (session) restoreYt(session);
        else restoreYt({ previousYt, changedYt });
        sessions.delete(request.requestId);
        publishResult({
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (request.ytConfig) {
          if (previousYt) runtimeWindow.yt = previousYt;
          else delete runtimeWindow.yt;
        }
      }
    })();
  };

  runtimeWindow.__seamindBotGuardMint = (request) => {
    runtimeWindow.__seamindBotGuardResult = null;
    void (async () => {
      try {
        const session = sessions.get(request.requestId);
        if (!session) throw new Error('The BotGuard snapshot session expired.');
        const minter = await WebPoMinter.create(
          { integrityToken: request.integrityToken },
          session.signals,
        );
        const token = await minter.mintAsWebsafeString(request.contentBinding);
        publishResult({ requestId: request.requestId, ok: true, token });
      } catch (error) {
        publishResult({
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        const session = sessions.get(request.requestId);
        if (session) restoreYt(session);
        sessions.delete(request.requestId);
      }
    })();
  };
}
