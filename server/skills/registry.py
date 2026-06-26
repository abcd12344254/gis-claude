"""
====== Skill 注册中心 ======

扫描 server/skills/ 目录下所有 .md 文件，
解析 YAML frontmatter + Markdown body，
提供 Skill 加载、匹配、System Prompt 拼装功能。
"""

import os
import re
import yaml
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field


@dataclass
class Skill:
    """Skill 定义（与 HermesAgent SKILL.md 规范对齐）"""
    name: str
    version: str
    description: str
    triggers: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    body: str = ""  # Markdown 正文
    file_path: str = ""


class SkillRegistry:
    """Skill 注册与加载引擎"""

    def __init__(self, skills_dir: str = None):
        if skills_dir is None:
            skills_dir = os.path.join(os.path.dirname(__file__))
        self.skills_dir = Path(skills_dir)
        self._skills: dict[str, Skill] = {}

    def load_all(self) -> list[Skill]:
        """扫描 skills 目录，加载所有 SKILL.md 文件"""
        self._skills = {}

        if not self.skills_dir.exists():
            return []

        for md_file in self.skills_dir.glob("*.md"):
            try:
                skill = self._parse_skill_file(md_file)
                if skill:
                    self._skills[skill.name] = skill
            except Exception as e:
                print(f"[SkillRegistry] Failed to parse {md_file}: {e}")

        return list(self._skills.values())

    def _parse_skill_file(self, file_path: Path) -> Optional[Skill]:
        """解析单个 SKILL.md 文件：YAML frontmatter + Markdown body"""
        content = file_path.read_text(encoding="utf-8")

        # 解析 YAML frontmatter
        frontmatter_match = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)", content, re.DOTALL)
        if not frontmatter_match:
            return None

        try:
            meta = yaml.safe_load(frontmatter_match.group(1))
        except yaml.YAMLError:
            return None

        if not meta or "name" not in meta:
            return None

        body = frontmatter_match.group(2).strip()

        return Skill(
            name=meta.get("name", ""),
            version=meta.get("version", "1.0"),
            description=meta.get("description", ""),
            triggers=meta.get("triggers", []),
            dependencies=meta.get("dependencies", []),
            body=body,
            file_path=str(file_path),
        )

    def get(self, name: str) -> Optional[Skill]:
        """按名称获取 Skill"""
        return self._skills.get(name)

    def list_all(self) -> list[dict]:
        """列出所有 Skill 的摘要信息"""
        return [
            {
                "name": s.name,
                "version": s.version,
                "description": s.description,
                "triggers": s.triggers[:5],  # 只返回前5个 trigger
                "dependencies": s.dependencies,
            }
            for s in self._skills.values()
        ]

    def match(self, user_message: str) -> list[Skill]:
        """
        按 triggers 字段匹配相关 Skill。

        对用户消息和每个 Skill 的 triggers 做关键词匹配，
        返回匹配到的 Skill 列表（按触发词数量排序）。
        """
        scored = []
        msg_lower = user_message.lower()

        for skill in self._skills.values():
            score = 0
            for trigger in skill.triggers:
                if trigger in msg_lower:
                    score += 1
            if score > 0:
                scored.append((score, skill))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [s for _, s in scored]

    def build_system_prompt(self, base_instructions: str = "",
                            matched_skills: list[Skill] = None) -> str:
        """
        拼装完整 System Prompt。

        Args:
            base_instructions: 基础指令（如 GEOJSON_INSTRUCTION）
            matched_skills: 匹配的 Skill 列表（可选，不传则包含全部 Skill）

        Returns:
            完整的 System Prompt 字符串
        """
        parts = ["你是 GIS Claude，专业的地理信息系统智能助手。\n"]

        if base_instructions:
            parts.append(base_instructions)
            parts.append("")

        # 注入匹配的 Skill
        skills_to_inject = matched_skills or list(self._skills.values())
        for skill in skills_to_inject:
            if skill.body:
                parts.append(f"## {skill.description}")
                parts.append(skill.body)
                parts.append("")

        parts.append("请用中文回答。回答要专业、准确、实用。")

        return "\n".join(parts)


# 全局单例
_registry: Optional[SkillRegistry] = None


def get_skill_registry() -> SkillRegistry:
    """获取 Skill 注册表单例"""
    global _registry
    if _registry is None:
        _registry = SkillRegistry()
        _registry.load_all()
    return _registry
