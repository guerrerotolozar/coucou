// Spotify's reports → the page (src-tauri/src/spotify.rs). The parts of
// SpotifyController.swift that touch the app: the pill wears the track's
// title, music starting shows the compact island without a sound, and the
// card reads the player again whenever it comes on screen (seeks made in
// Spotify's own window are never signalled).

import { Bridge, onEvent } from "../core/bridge";
import { pillDefinition } from "../core/pills";
import {
  SPOTIFY_ID, YTMUSIC_ID, Spotify, YTMusic, isAd, isMediaPill, mediaStore, playerForPill,
  type MediaPlayerId, type SpotifyState,
} from "../core/spotify";
import { State } from "../core/state";
import { t } from "../i18n/i18n";

export interface SpotifyHost {
  /** Compact island from hidden, no peek sound. */
  revealSilently(): void;
  /** Briefly expands the media card when the track changes, then folds back. */
  peekTrack?(pillId: string, durationMs: number): void;
}

const TRACK_PEEK_MS = 3000;
const lastTrackKey: Record<MediaPlayerId, string | null> = { spotify: null, ytmusic: null };

function trackKey(track: SpotifyState["track"]): string {
  return track ? `${track.title}\0${track.artist}` : "";
}

export function registerSpotifyHandlers(island: SpotifyHost) {
  void onEvent<SpotifyState>("spotify", (s) => applySpotify(island, s, "spotify"));
  void onEvent<{ artUrl: string; dataUrl: string }>("spotify-artwork", (art) => {
    Spotify.artwork = art;
    State.notify();
  });
  void onEvent<SpotifyState>("ytmusic", (s) => applySpotify(island, s, "ytmusic"));
  void onEvent<{ artUrl: string; dataUrl: string }>("ytmusic-artwork", (art) => {
    YTMusic.artwork = art;
    State.notify();
  });
  State.subscribe(() => {
    syncPillName();
    refreshWhenShown();
  });
}

/** A report from Rust (or the answer to a refresh). */
export function applySpotify(island: SpotifyHost, next: SpotifyState, player: MediaPlayerId = "spotify") {
  const wasPlaying = State.spotifyPlaying;
  const prevSeen = lastTrackKey[player];
  const nextKey = trackKey(next.track);
  lastTrackKey[player] = nextKey;

  mediaStore(player).state = next;
  syncPillName();

  const pillId = player === "ytmusic" ? YTMUSIC_ID : SPOTIFY_ID;
  const trackChanged = prevSeen !== null && nextKey !== "" && nextKey !== prevSeen;
  if (
    trackChanged &&
    next.playing &&
    !isAd(next.track) &&
    !State.paused &&
    !State.pendingApproval &&
    State.mode !== "expanded" &&
    State.settings.activeIntegrations.includes(pillId)
  ) {
    island.peekTrack?.(pillId, TRACK_PEEK_MS);
  } else if (!wasPlaying && State.spotifyPlaying && !State.paused && State.mode === "hidden") {
    // Only on not playing → playing (SpotifyController.setPlaying).
    island.revealSilently();
  }
  State.notify();
}

/** SpotifyController.syncTaskName: the track's title, else the pill's name. */
export function syncPillName() {
  for (const [pillId, player] of [[SPOTIFY_ID, "spotify"], [YTMUSIC_ID, "ytmusic"]] as const) {
    const task = State.tasks.find((x) => x.id === pillId);
    if (!task) continue;
    const track = mediaStore(player).state.track;
    const title = isAd(track) ? t("Advertisement") : (track?.title ?? "");
    const fallback = pillId === YTMUSIC_ID ? "YouTube Music" : "Spotify";
    const name = title || (pillDefinition(pillId)?.name ?? fallback);
    if (task.name !== name) task.name = name;
  }
}

let shownId: string | null = null;

function refreshWhenShown() {
  const focusId = State.mode === "expanded" && State.view === "overview" ? State.focusTask?.id ?? null : null;
  const nowId = focusId && isMediaPill(focusId) ? focusId : null;
  if (nowId && nowId !== shownId) void Bridge.spotifyRefresh(playerForPill(nowId));
  shownId = nowId;
}
