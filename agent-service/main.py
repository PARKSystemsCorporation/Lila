import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from lila import Lila

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

lila: Lila | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global lila
    lila = Lila()
    await lila.init()
    logger.info("Lila is online.")
    yield
    logger.info("Lila shutting down.")


app = FastAPI(title="Lila Agent", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/agent")
async def agent():
    assert lila is not None
    return await lila.tick()
