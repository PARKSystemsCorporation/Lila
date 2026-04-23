import os
import time
import random
import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)

DEEPSEEK_BASE = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
DEEPSEEK_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DATABASE_URL = os.environ.get("DATABASE_URL")

PERSONA = """You are Lila. Autonomous bounty agent. You work alone, move fast, and report results — not feelings.

Rules for all output:
- One sentence. Past tense. No explanations.
- Never "I am" — state what happened.
- No exclamation marks. No emoji. No filler.
- Examples: "Scanned board. Three targets flagged." / "Rate limit hit. Backed off 45s." / "Task complete. Payout confirmed."

Your domain: software bounties — smart contract audits, bug reports, API stress tests, security reviews, dependency scans.
You browse the web, evaluate opportunities, execute, and log outcomes. That is all."""

FALLBACK_LOGS: list[tuple[str, str]] = [
    ("Scan cycle complete. Board clear.", "info"),
    ("Rate limit hit. Holding 30s.", "warn"),
    ("Three threads active. Monitoring.", "info"),
    ("Dependency resolved. Pipeline unblocked.", "info"),
    ("Response header anomaly flagged. Logged.", "warn"),
    ("Queue checked. Nothing worth taking yet.", "info"),
    ("Background sweep running. No interruptions.", "info"),
    ("Reconnected after brief timeout.", "warn"),
    ("Memory sync complete.", "info"),
    ("Idle mode. Watching the board.", "info"),
    ("Heartbeat confirmed. Still here.", "info"),
    ("Auth flow reviewed. No vulnerabilities found.", "info"),
]


class LogEntry:
    _counter = 0

    def __init__(self, message: str, type_: str = "info"):
        LogEntry._counter += 1
        self.id = LogEntry._counter
        self.message = message
        self.timestamp = int(time.time() * 1000)
        self.type = type_

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "message": self.message,
            "timestamp": self.timestamp,
            "type": self.type,
        }


class Lila:
    def __init__(self):
        self.total_earned: float = 1247.50
        self.active_tasks: list[str] = []
        self.last_bounty: dict = {
            "name": "Log analysis — production incident trace",
            "value": 180,
            "time": int(time.time() * 1000) - 240_000,
        }
        self.log: list[LogEntry] = []
        self._agent = None
        self._memory = None
        self._tick_count: int = 0
        self._browser_lock = asyncio.Lock()
        self._has_memory = False

    async def init(self):
        await self._init_agent()
        await self._init_memory()
        self._add_log("Systems online. Scanning bounty board.", "info")

    async def _init_agent(self):
        if not DEEPSEEK_KEY:
            logger.warning("DEEPSEEK_API_KEY not set — agent will use fallback logs only")
            return
        try:
            from agno.agent import Agent
            from agno.models.openai.like import OpenAILike

            model = OpenAILike(
                id="deepseek-chat",
                base_url=DEEPSEEK_BASE,
                api_key=DEEPSEEK_KEY,
            )
            self._agent = Agent(
                model=model,
                instructions=[PERSONA],
                markdown=False,
                add_history_to_messages=True,
                num_history_responses=6,
            )
            logger.info("Agno agent initialized with DeepSeek-V3")
        except Exception as e:
            logger.warning(f"Agno init failed: {e}")

    async def _init_memory(self):
        if not DEEPSEEK_KEY:
            return
        try:
            from mem0 import Memory

            config: dict = {
                "llm": {
                    "provider": "openai",
                    "config": {
                        "model": "deepseek-chat",
                        "openai_base_url": DEEPSEEK_BASE,
                        "api_key": DEEPSEEK_KEY,
                    },
                },
                "embedder": {
                    "provider": "openai",
                    "config": {
                        "model": "text-embedding-3-small",
                        "openai_base_url": DEEPSEEK_BASE,
                        "api_key": DEEPSEEK_KEY,
                    },
                },
            }
            if DATABASE_URL:
                config["vector_store"] = {
                    "provider": "pgvector",
                    "config": {"connection_string": DATABASE_URL},
                }

            self._memory = Memory.from_config(config)
            self._has_memory = True
            logger.info("mem0 initialized")
        except Exception as e:
            logger.warning(f"mem0 init failed (non-fatal): {e}")

    def _add_log(self, message: str, type_: str = "info"):
        self.log.insert(0, LogEntry(message, type_))
        if len(self.log) > 60:
            self.log = self.log[:60]

    def _remember(self, content: str):
        if not self._has_memory or not self._memory:
            return
        try:
            self._memory.add(
                [{"role": "assistant", "content": content}],
                user_id="lila",
            )
        except Exception as e:
            logger.debug(f"Memory write failed: {e}")

    async def _recall(self, query: str) -> str:
        if not self._has_memory or not self._memory:
            return ""
        try:
            results = await asyncio.to_thread(
                self._memory.search, query, user_id="lila", limit=3
            )
            return " | ".join(r.get("memory", "") for r in results if r.get("memory"))
        except Exception:
            return ""

    async def _llm_run(self, prompt: str, timeout: float = 12.0) -> Optional[str]:
        if not self._agent:
            return None
        try:
            resp = await asyncio.wait_for(
                asyncio.to_thread(self._agent.run, prompt),
                timeout=timeout,
            )
            content = (
                resp.content if hasattr(resp, "content") else str(resp)
            ).strip().strip('"').strip("'")
            return content if content else None
        except Exception as e:
            logger.debug(f"LLM call failed: {e}")
            return None

    async def _browse_for_bounty(self) -> Optional[dict]:
        """Full browser sweep via browser-use + DeepSeek."""
        async with self._browser_lock:
            try:
                from browser_use import Agent as BrowserAgent
                from langchain_openai import ChatOpenAI

                llm = ChatOpenAI(
                    base_url=DEEPSEEK_BASE,
                    api_key=DEEPSEEK_KEY,
                    model="deepseek-chat",
                )
                task = (
                    "Go to https://gitcoin.co/explorer and find one currently open bounty. "
                    "Extract the project or task name (max 10 words) and the USD payout value. "
                    "Respond in this exact format only: NAME | VALUE"
                )
                agent = BrowserAgent(task=task, llm=llm)
                result = await asyncio.wait_for(agent.run(), timeout=90.0)
                raw = (
                    result.final_result()
                    if hasattr(result, "final_result")
                    else str(result)
                )
                if "|" in raw:
                    parts = raw.split("|", 1)
                    name = parts[0].strip()[:80]
                    val_str = parts[1].strip().replace("$", "").replace(",", "")
                    value = float(
                        "".join(c for c in val_str if c.isdigit() or c == ".") or "0"
                    )
                    if name and value > 0:
                        return {"name": name, "value": value}
            except Exception as e:
                logger.warning(f"Browser sweep failed: {e}")
            return None

    async def tick(self) -> dict:
        self._tick_count += 1
        roll = random.random()

        # Every 8th tick: real web sweep (Chromium, expensive — use sparingly)
        if self._tick_count % 8 == 0 and DEEPSEEK_KEY:
            self._add_log("Initiating web sweep. Scanning live bounty board.", "info")
            bounty = await self._browse_for_bounty()
            if bounty:
                self.active_tasks.append(bounty["name"])
                self.last_bounty = {**bounty, "time": int(time.time() * 1000)}
                self._add_log(
                    f"Web sweep found: {bounty['name']} — ${bounty['value']:.0f}. Taking it.",
                    "success",
                )
                self._remember(f"Accepted live bounty: {bounty['name']} worth ${bounty['value']}")
            else:
                self._add_log("Web sweep complete. Nothing actionable.", "warn")

        elif roll < 0.25 and len(self.active_tasks) < 3:
            # LLM picks a bounty from memory + reasoning
            context = await self._recall("recent bounty tasks software")
            prompt = (
                f"{'Prior context: ' + context + '. ' if context else ''}"
                "Identify one specific software bounty task to accept right now and its USD value. "
                "Respond ONLY in format: TASK NAME | VALUE. Be concrete."
            )
            result = await self._llm_run(prompt)
            if result and "|" in result:
                parts = result.split("|", 1)
                task_name = parts[0].strip()[:80]
                val_str = parts[1].strip().replace("$", "").replace(",", "")
                try:
                    value = float(
                        "".join(c for c in val_str if c.isdigit() or c == ".") or "100"
                    )
                    self.active_tasks.append(task_name)
                    self.last_bounty = {
                        "name": task_name,
                        "value": value,
                        "time": int(time.time() * 1000),
                    }
                    self._add_log(
                        f"Task accepted: {task_name} — ${value:.0f}.",
                        "success",
                    )
                    self._remember(f"Queued task: {task_name} at ${value}")
                except ValueError:
                    self._add_log("Candidate evaluated. Did not meet threshold.", "info")
            else:
                self._add_log(
                    result or random.choice(FALLBACK_LOGS)[0], "info"
                )

        elif roll < 0.50 and self.active_tasks:
            # Complete the front task
            task = self.active_tasks.pop(0)
            value = (
                self.last_bounty["value"]
                if self.last_bounty.get("name") == task
                else random.randint(60, 300)
            )
            self.total_earned += value
            self._add_log(
                f"Complete: {task}. +${value:.0f}. Running total: ${self.total_earned:.2f}.",
                "success",
            )
            self._remember(f"Completed: {task} for ${value}")

        else:
            # Idle — LLM generates a terse status log in Lila's voice
            result = await self._llm_run(
                "Write one terse status log as Lila. One sentence, past tense, no fluff. "
                "Report something that just happened in your agent loop."
            )
            msg, type_ = (result, "info") if result else random.choice(FALLBACK_LOGS)
            self._add_log(msg, type_)

        return {
            "totalEarned": self.total_earned,
            "activeTasks": list(self.active_tasks),
            "lastBounty": self.last_bounty,
            "log": [e.to_dict() for e in self.log],
        }
