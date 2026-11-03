export interface TranscriptCue {
  id: string;
  start: number; // in seconds
  end: number; // in seconds
  text: string; // original text
  translation?: string; // optional translated text (e.g. Chinese)
}

export interface TranscriptTrack {
  id: string;
  languageCode: string;
  name: string;
  isTranslatable?: boolean;
  isGenerated?: boolean;
  isDefault?: boolean;
}

export interface TranscriptTranslationLanguage {
  languageCode: string;
  name: string;
}

export interface TranscriptResult {
  videoId: string;
  tracks: TranscriptTrack[];
  translationLanguages?: TranscriptTranslationLanguage[];
  activeTrackId: string | null;
  cues: TranscriptCue[];
}

export type TranscriptViewMode = 'bilingual' | 'original' | 'translation';
