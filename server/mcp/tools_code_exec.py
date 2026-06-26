"""
====== Python 代码执行 MCP 工具 ======

在隔离的 subprocess 中执行 Python 代码。
预装 GIS 依赖库（geopandas/shapely/rasterio等）。
支持超时和输出限制。
"""

import subprocess, tempfile, os, sys
from pathlib import Path
from mcp.registry import MCPToolDef

# 可用预装库
PREINSTALLED_LIBS = [
    "geopandas", "shapely", "fiona", "rasterio", "pyproj",
    "pandas", "numpy", "scipy", "matplotlib", "scikit-learn",
    "networkx", "rtree",
]

DEFAULT_TIMEOUT = 30  # 秒
MAX_OUTPUT = 10000    # 字符


async def _execute_python_code(params: dict) -> dict:
    """在隔离进程中执行 Python 代码"""
    code = params.get("code", "")
    timeout = params.get("timeout", DEFAULT_TIMEOUT)
    if not code.strip():
        return {"success": False, "error": "代码为空"}

    # 写入临时文件
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(code)
        tmp_path = f.name

    try:
        result = subprocess.run(
            [sys.executable, tmp_path],
            capture_output=True, text=True, timeout=min(timeout, 60),
            cwd=str(Path(__file__).parent.parent.parent),
        )
        stdout = result.stdout[:MAX_OUTPUT]
        stderr = result.stderr[:MAX_OUTPUT]

        return {
            "success": result.returncode == 0,
            "exit_code": result.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "execution_time_ms": int(result.returncode),
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": f"代码执行超时（>{timeout}秒）", "timeout": timeout}
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


async def _check_environment(params: dict) -> dict:
    """检查 Python 沙箱环境状态"""
    available = []
    missing = []
    for lib in PREINSTALLED_LIBS:
        try:
            __import__(lib)
            available.append(lib)
        except ImportError:
            missing.append(lib)

    return {
        "python_version": sys.version,
        "executable": sys.executable,
        "available_libs": available,
        "missing_libs": missing,
        "libs_suggestion": f"安装缺失库: pip install {' '.join(missing)}" if missing else "全部 GIS 依赖已就绪",
    }


def register_code_exec_tools(registry):
    registry.register(MCPToolDef(
        name="execute_python_code",
        description="在隔离的 Python 沙箱中执行代码。预装 geopandas/shapely/rasterio/pandas/numpy/scipy/matplotlib。超时30秒，输出限制10000字符。",
        category="code_exec",
        parameters={
            "code": {"type": "string", "required": True, "description": "Python 代码"},
            "timeout": {"type": "integer", "required": False, "description": "超时秒数（默认30，最大60）"},
        },
        returns={"type": "object", "description": "{success, exit_code, stdout, stderr}"},
        handler=_execute_python_code,
        examples=['{"code": "import geopandas as gpd; gdf = gpd.read_file(\'data.geojson\'); print(len(gdf))"}'],
    ))
    registry.register(MCPToolDef(
        name="check_environment",
        description="检查 Python 沙箱环境状态：已安装/缺失的 GIS 依赖库列表",
        category="code_exec",
        parameters={},
        returns={"type": "object", "description": "{python_version, available_libs, missing_libs}"},
        handler=_check_environment,
    ))
