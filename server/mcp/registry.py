"""
====== MCP 工具注册中心 ======

按 HermesAgent 文档第 7 章规范，统一管理所有 MCP 工具的定义与执行。

每个 MCP 工具包含：
- 标准 JSON Schema 参数定义
- 参数校验
- CRS 前置检查（分析类工具）
- 统一的执行接口和错误处理
"""

import re
import json
from typing import Any, Callable, Optional
from dataclasses import dataclass, field


@dataclass
class MCPToolDef:
    """MCP 工具标准定义（与 HermesAgent 文档对齐）"""
    name: str                    # 工具唯一名称
    description: str             # 功能描述
    category: str                # 分类：resource / preprocess / analysis / cartography / code_exec
    parameters: dict             # JSON Schema 参数定义
    returns: dict                # 返回值描述
    handler: Callable            # 异步处理函数 async (params) -> dict
    requires_crs_check: bool = False  # 是否需要坐标系前置检查
    examples: list[str] = field(default_factory=list)


class MCPRegistry:
    """MCP 工具注册与调度中心"""

    def __init__(self):
        self._tools: dict[str, MCPToolDef] = {}
        # 需要 CRS 检查的分析类型
        self._crs_sensitive_ops = {
            "buffer", "area", "distance", "hotspot", "interpolation",
            "network", "grid", "density", "cluster", "zonal"
        }

    def register(self, tool: MCPToolDef):
        """注册一个 MCP 工具"""
        self._tools[tool.name] = tool

    def get(self, name: str) -> Optional[MCPToolDef]:
        return self._tools.get(name)

    def list_all(self) -> list[dict]:
        """列出全部工具的基本信息"""
        return [
            {
                "name": t.name,
                "description": t.description,
                "category": t.category,
                "parameters": t.parameters,
                "returns": t.returns,
                "requires_crs_check": t.requires_crs_check,
                "examples": t.examples,
            }
            for t in self._tools.values()
        ]

    def list_by_category(self, category: str) -> list[dict]:
        """按分类列出工具"""
        return [
            {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            }
            for t in self._tools.values()
            if t.category == category
        ]

    def build_tool_list_for_llm(self) -> list[dict]:
        """
        生成适合 LLM function calling 的工具列表。

        每个工具包含：name, description, parameters (JSON Schema)
        这是 DeepSeek 等 LLM 的 function calling 标准格式。
        """
        tools = []
        for t in self._tools.values():
            tools.append({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": {
                        "type": "object",
                        "properties": self._parse_params_to_properties(t.parameters),
                        "required": self._extract_required(t.parameters),
                    },
                },
                # 非标准字段，供前端展示
                "_category": t.category,
                "_returns": t.returns,
            })
        return tools

    def _parse_params_to_properties(self, params: dict) -> dict:
        """将简化的参数定义转为 JSON Schema properties"""
        props = {}
        for key, info in params.items():
            prop = {"description": info.get("description", "")}
            ptype = info.get("type", "string")
            if ptype == "number":
                prop["type"] = "number"
            elif ptype == "integer":
                prop["type"] = "integer"
            elif ptype == "boolean":
                prop["type"] = "boolean"
            elif ptype == "array":
                prop["type"] = "array"
                prop["items"] = info.get("items", {"type": "string"})
            elif ptype == "object":
                prop["type"] = "object"
            else:
                prop["type"] = "string"
            if "enum" in info:
                prop["enum"] = info["enum"]
            if "default" in info:
                prop["default"] = info["default"]
            props[key] = prop
        return props

    def _extract_required(self, params: dict) -> list[str]:
        """提取必填参数列表"""
        return [k for k, v in params.items() if v.get("required", False)]

    async def execute(self, name: str, params: dict) -> dict:
        """
        执行指定的 MCP 工具。

        流程：查找工具 → 参数校验 → (可选)CRS检查 → 执行 → 返回结果

        Returns:
            {"success": true, "data": ..., "warnings": [...]}
            或
            {"success": false, "error": "..."}
        """
        tool = self._tools.get(name)
        if not tool:
            return {"success": False, "error": f"未知 MCP 工具: {name}"}

        # 参数校验
        try:
            validated = self._validate_params(tool, params)
        except ValueError as e:
            return {"success": False, "error": f"参数错误: {e}"}

        # 执行
        try:
            result = await tool.handler(validated)
            return {"success": True, "data": result}
        except Exception as e:
            return {"success": False, "error": f"执行失败: {str(e)}"}

    def _validate_params(self, tool: MCPToolDef, params: dict) -> dict:
        """校验参数类型和必填项"""
        validated = {}
        for key, info in tool.parameters.items():
            value = params.get(key)
            if value is None:
                if info.get("required", False):
                    raise ValueError(f"缺少必填参数: {key}")
                if "default" in info:
                    value = info["default"]
            if value is not None:
                ptype = info.get("type", "string")
                if ptype == "number" or ptype == "integer":
                    try:
                        value = float(value) if ptype == "number" else int(value)
                    except (TypeError, ValueError):
                        raise ValueError(f"参数 {key} 需要数值类型")
                validated[key] = value
        return validated


# 全局单例
_registry: Optional[MCPRegistry] = None


def get_mcp_registry() -> MCPRegistry:
    global _registry
    if _registry is None:
        _registry = MCPRegistry()
    return _registry
