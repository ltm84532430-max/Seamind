use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaProvider {
    YouTube,
}

pub struct MediaResolveRequest {
    pub provider: MediaProvider,
    pub video_id: String,
}

impl MediaResolveRequest {
    pub fn youtube(video_id: String) -> Self {
        Self {
            provider: MediaProvider::YouTube,
            video_id,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaType {
    ProgressiveMp4,
    Hls,
    Dash,
    SeparateStreams,
    Unsupported,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "backend", rename_all = "camelCase")]
#[serde(rename_all_fields = "camelCase")]
pub enum PlaybackResolution {
    #[serde(rename = "html5")]
    Html5 {
        provider: String,
        media_type: MediaType,
        url: String,
        mime_type: String,
    },
    #[serde(rename = "mpv")]
    Mpv {
        provider: String,
        media_type: MediaType,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        audio_url: Option<String>,
        reason: String,
    },
}

/// A provider-independent seam between URL extraction and desktop playback.
pub trait MediaResolver: Send + Sync {
    fn resolve(&self, request: &MediaResolveRequest) -> Result<PlaybackResolution, String>;
}
