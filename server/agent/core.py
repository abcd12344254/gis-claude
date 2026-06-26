"""
====== GIS Agent 核心 ======

Agent 主循环：接收用户消息 + 地图上下文 → 匹配 Skill →
构建增强 System Prompt → 调用 LLM → 返回结构化结果。

与现有 /api/chat 的区别：
- Skill 动态注入 System Prompt（而非前端硬编码）
- 自动附带 CRS 检查建议
- 返回匹配的 Skill 信息
"""

import os
import json
import httpx
from typing import Optional
from dataclasses import dataclass, field
from skills.registry import get_skill_registry


@dataclass
class MapState:
    center: list[float]  # [lng, lat]
    zoom: float
    bounds: Optional[list[float]] = None  # [west, south, east, north]


@dataclass
class LayerSummary:
    id: str = ""
    name: str = ""
    type: str = ""
    visible: bool = True
    feature_count: int = 0


@dataclass
class AgentRequest:
    message: str
    map_state: MapState
    layers: list[LayerSummary] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)


@dataclass
class AgentResponse:
    messages: list[dict] = field(default_factory=list)
    matched_skills: list[str] = field(default_factory=list)
    crs_warnings: list[str] = field(default_factory=list)


class GISAgent:
    """GIS 领域 Agent — Skill 增强的 LLM 对话引擎"""

    def __init__(self):
        self.skill_registry = get_skill_registry()
        self._deepseek_api_key: Optional[str] = None
        self._proxy: Optional[str] = None

    def _load_config(self):
        """加载 API Key 和代理配置"""
        if self._deepseek_api_key is None:
            self._deepseek_api_key = os.getenv("DEEPSEEK_API_KEY", "")
        if self._proxy is None:
            self._proxy = os.getenv("HTTPS_PROXY", "")

    def build_spatial_context(self, map_state: MapState, layers: list[LayerSummary]) -> str:
        """构建地图空间上下文文本（注入到 System Prompt）"""
        parts = []

        parts.append(f"地图中心: [{map_state.center[0]:.6f}, {map_state.center[1]:.6f}]")
        parts.append(f"缩放级别: {map_state.zoom:.1f}")

        if map_state.bounds:
            w, s, e, n = map_state.bounds
            parts.append(f"视野范围(WGS84): [{w:.6f}, {s:.6f}] 到 [{e:.6f}, {n:.6f}]")
            lat_mid = (s + n) / 2
            deg_to_km = 111.32
            import math
            cos_lat = math.cos(lat_mid * math.pi / 180)
            parts.append(f"视野约 {((e - w) * deg_to_km * cos_lat):.1f}km × {((n - s) * deg_to_km):.1f}km")

        visible_layers = [l for l in layers if l.visible]
        if visible_layers:
            parts.append(f"可见图层 (共{len(visible_layers)}个):")
            for l in visible_layers:
                parts.append(f"  · \"{l.name}\" — {l.type} (约{l.feature_count}个要素)")

        return "\n".join(parts)

    def build_system_prompt(self, user_message: str, spatial_context: str,
                            base_instructions: str = "") -> tuple[str, list[str]]:
        """
        构建增强的 System Prompt。

        Returns:
            (完整的 System Prompt, 匹配的 Skill 名称列表)
        """
        # 匹配相关 Skill
        matched = self.skill_registry.match(user_message)
        matched_names = [s.name for s in matched]

        # 始终包含 gis_domain_knowledge（领域知识基底）
        gis_knowledge = self.skill_registry.get("gis_domain_knowledge")
        if gis_knowledge and gis_knowledge not in matched:
            matched.append(gis_knowledge)
            matched_names.append("gis_domain_knowledge")

        # 始终包含 crs_checklist（坐标系意识）
        crs_skill = self.skill_registry.get("crs_checklist")
        if crs_skill and crs_skill not in matched:
            matched.append(crs_skill)

        # 始终包含 bracket_commands（指令系统——最关键！）
        bracket_skill = self.skill_registry.get("bracket_commands")
        if bracket_skill and bracket_skill not in matched:
            matched.insert(0, bracket_skill)  # 放在最前面

        # 拼装 Prompt
        prompt = self.skill_registry.build_system_prompt(
            base_instructions=base_instructions,
            matched_skills=matched,
        )

        # 注入空间上下文
        prompt += f"\n\n## 当前地图状态\n{spatial_context}\n"

        return prompt, matched_names

    async def chat(self, request: AgentRequest,
                   api_key: str = "", auth_token: str = "") -> AgentResponse:
        """
        处理对话请求。

        1. 构建增强 System Prompt
        2. 组装消息历史
        3. 调用 DeepSeek
        4. 返回 AI 回复 + 匹配的 Skill 信息
        """
        self._load_config()

        # 使用传入的 api_key，或 fallback 到环境变量
        key = api_key or self._deepseek_api_key

        # 构建空间上下文
        spatial_context = self.build_spatial_context(request.map_state, request.layers)

        # 构建增强 System Prompt
        system_prompt, matched_skills = self.build_system_prompt(
            request.message, spatial_context
        )

        # 组装消息
        messages = [{"role": "system", "content": system_prompt}]

        # 添加历史（最近10轮）
        for h in request.history[-20:]:
            role = h.get("role", "user")
            if role in ("user", "assistant"):
                messages.append({"role": role, "content": h.get("content", "")})

        # 添加当前用户消息（含空间上下文标注）
        messages.append({
            "role": "user",
            "content": f"[当前地图状态]\n{spatial_context}\n\n[用户问题]\n{request.message}",
        })

        # 调用 DeepSeek
        if not key:
            return AgentResponse(
                messages=[{"role": "assistant", "content": "错误：未配置 DeepSeek API Key。请在右上角设置 API Key 或在 server/.env 中配置 DEEPSEEK_API_KEY。"}],
                matched_skills=matched_skills,
            )

        try:
            client_config = {
                "base_url": "https://api.deepseek.com",
                "timeout": httpx.Timeout(120.0),
                "headers": {
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
            }

            if self._proxy:
                client_config["proxy"] = self._proxy

            async with httpx.AsyncClient(**client_config) as client:
                resp = await client.post("/v1/chat/completions", json={
                    "model": "deepseek-chat",
                    "messages": messages,
                    "temperature": 0.7,
                    "max_tokens": 4096,
                    "stream": False,
                })
                resp.raise_for_status()
                data = resp.json()

            choice = data.get("choices", [{}])[0]
            ai_content = choice.get("message", {}).get("content", "(无回复)")

            return AgentResponse(
                messages=[{"role": "assistant", "content": ai_content}],
                matched_skills=matched_skills,
            )

        except httpx.HTTPStatusError as e:
            return AgentResponse(
                messages=[{"role": "assistant", "content": f"DeepSeek API 错误 (HTTP {e.response.status_code})：{e.response.text[:200]}"}],
                matched_skills=matched_skills,
            )
        except Exception as e:
            return AgentResponse(
                messages=[{"role": "assistant", "content": f"请求失败：{str(e)}"}],
                matched_skills=matched_skills,
            )

    async def chat_stream(self, request: AgentRequest,
                          api_key: str = "", auth_token: str = ""):
        """
        SSE 流式对话。

        Yields: SSE data chunks (str)
        """
        self._load_config()
        key = api_key or self._deepseek_api_key

        spatial_context = self.build_spatial_context(request.map_state, request.layers)
        system_prompt, matched_skills = self.build_system_prompt(
            request.message, spatial_context
        )

        messages = [{"role": "system", "content": system_prompt}]
        for h in request.history[-20:]:
            role = h.get("role", "user")
            if role in ("user", "assistant"):
                messages.append({"role": role, "content": h.get("content", "")})
        messages.append({
            "role": "user",
            "content": f"[当前地图状态]\n{spatial_context}\n\n[用户问题]\n{request.message}",
        })

        if not key:
            yield f"data: {json.dumps({'error': 'No API key configured'})}\n\n"
            return

        try:
            client_config = {
                "base_url": "https://api.deepseek.com",
                "timeout": httpx.Timeout(120.0),
                "headers": {
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
            }
            if self._proxy:
                client_config["proxy"] = self._proxy

            async with httpx.AsyncClient(**client_config) as client:
                async with client.stream("POST", "/v1/chat/completions", json={
                    "model": "deepseek-chat",
                    "messages": messages,
                    "temperature": 0.7,
                    "max_tokens": 4096,
                    "stream": True,
                }) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if line.startswith("data: "):
                            yield f"{line}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

        # 发送元数据
        yield f"data: {json.dumps({'matched_skills': matched_skills})}\n\n"


# 全局单例
_agent: Optional[GISAgent] = None


def get_gis_agent() -> GISAgent:
    global _agent
    if _agent is None:
        _agent = GISAgent()
    return _agent
