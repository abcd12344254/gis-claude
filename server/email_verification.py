"""
邮件验证码模块 — SMTP 发送 + 内存存储
"""
import os
import random
import smtplib
import time
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# === 配置 ===
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", SMTP_USER)

# 验证码有效期（秒）
CODE_EXPIRE_SECONDS = 300
# 发送间隔（秒）
SEND_INTERVAL_SECONDS = 60

# 内存存储：{email: {code, expires_at, last_sent}}
_verification_store: dict[str, dict] = {}


def generate_code() -> str:
    """生成 6 位数字验证码"""
    return str(random.randint(100000, 999999))


def can_send(email: str) -> tuple[bool, int]:
    """检查是否可以发送验证码，返回(是否可发送, 剩余等待秒数)"""
    record = _verification_store.get(email)
    if not record:
        return True, 0
    elapsed = time.time() - record.get("last_sent", 0)
    if elapsed >= SEND_INTERVAL_SECONDS:
        return True, 0
    return False, int(SEND_INTERVAL_SECONDS - elapsed)


def send_verification_code(email: str) -> dict:
    """发送验证码到邮箱，返回 {success, message}"""
    # 频率检查
    ok, wait = can_send(email)
    if not ok:
        return {"success": False, "message": f"发送太频繁，请 {wait} 秒后再试"}

    code = generate_code()
    expires_at = time.time() + CODE_EXPIRE_SECONDS

    _verification_store[email] = {
        "code": code,
        "expires_at": expires_at,
        "last_sent": time.time(),
    }

    # 如果没配 SMTP，跳过邮箱验证直接返回验证码
    if not SMTP_HOST or not SMTP_USER:
        print(f"[DEV] 验证码({email}): {code}")
        return {"success": True, "message": f"开发模式：验证码 {code}（有效期{CODE_EXPIRE_SECONDS//60}分钟）", "code": code}

    # SMTP 发送
    try:
        subject = "GIS Claude — 邮箱验证码"
        html = f"""
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #fafafa; border-radius: 12px;">
            <div style="text-align: center; margin-bottom: 24px;">
                <span style="font-size: 28px;">🌍</span>
                <h1 style="margin: 8px 0 0; font-size: 22px; color: #1a1a2e;">GIS Claude</h1>
                <p style="color: #999; font-size: 14px;">邮箱验证码</p>
            </div>
            <div style="background: #fff; border-radius: 8px; padding: 24px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06);">
                <p style="margin: 0 0 8px; color: #666; font-size: 14px;">你的验证码是</p>
                <div style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #1677ff; font-family: 'Courier New', monospace; margin-bottom: 8px;">
                    {code}
                </div>
                <p style="margin: 0; color: #999; font-size: 12px;">
                    有效期 {CODE_EXPIRE_SECONDS // 60} 分钟 · 请勿转发给他人
                </p>
            </div>
            <p style="text-align: center; margin-top: 16px; color: #bbb; font-size: 11px;">
                如果你没有注册 GIS Claude 账号，请忽略此邮件
            </p>
        </div>
        """

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = SMTP_FROM
        msg["To"] = email
        msg.attach(MIMEText(html, "html", "utf-8"))

        if SMTP_PORT == 465:
            server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=30)
        else:
            server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30)
        with server:
            if SMTP_PORT != 465:
                server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(SMTP_FROM, [email], msg.as_string())

        return {"success": True, "message": "验证码已发送，请检查邮箱"}
    except Exception as e:
        # SMTP 发送失败 → 降级为页面弹窗显示
        print(f"[Email] SMTP发送失败({e})，降级为弹窗显示验证码")
        return {"success": True, "message": f"邮件发送失败，降级为弹窗显示", "code": code}


def verify_code(email: str, code: str) -> bool:
    """
    验证邮箱验证码
    返回 True 表示验证通过
    """
    record = _verification_store.get(email)
    if not record:
        return False
    if time.time() > record["expires_at"]:
        del _verification_store[email]
        return False
    if record["code"] != code.strip():
        return False
    # 验证通过，删除记录
    del _verification_store[email]
    return True
