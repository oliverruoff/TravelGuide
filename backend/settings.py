from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    minimax_api_key: str = ""
    brave_api_key: str = ""
    app_secret: str = "dev-local-change-me"
    minimax_model: str = "MiniMax-M2.7"
    frontend_origin: str = "http://localhost:5173"
    minimax_base_url: str = "https://api.minimax.io"
    brave_base_url: str = "https://api.search.brave.com"
    overpass_url: str = "https://overpass-api.de/api/interpreter"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


@lru_cache
def get_settings() -> Settings:
    return Settings()

