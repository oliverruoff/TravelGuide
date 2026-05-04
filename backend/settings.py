from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    travelguide_language: str = "en"
    travelguide_tts_provider: str = "browser"
    travelguide_access_password: str = ""  # empty = no password required (dev only)
    minimax_api_key: str = ""
    brave_api_key: str = ""
    app_secret: str = "dev-local-change-me"
    minimax_model: str = "MiniMax-M2.7"
    minimax_tts_model: str = "speech-2.8-hd"
    minimax_tts_voice_id: str = "moss_audio_32c53f56-4606-11f1-8416-56cb9cf1b830"
    minimax_base_url: str = "https://api.minimax.io"
    brave_base_url: str = "https://api.search.brave.com"
    overpass_url: str = "https://overpass-api.de/api/interpreter"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
