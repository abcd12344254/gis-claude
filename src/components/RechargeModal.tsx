import React, { useState, useCallback } from 'react';
import { Modal, Tabs, Card, Button, InputNumber, Space, message, Tag, Row, Col } from 'antd';
import {
  CrownOutlined,
  ThunderboltOutlined,
  CheckCircleFilled,
} from '@ant-design/icons';
import { useGISStore } from '../store/useGISStore';
import { API_BASE } from '../utils/api';

interface RechargeModalProps {
  open: boolean;
  onClose: () => void;
  adminMode?: boolean;
  adminUserId?: number;
  adminUserEmail?: string;
  onSuccess?: () => void;
  isMobile?: boolean;
}

const PLAN_CONFIG: Record<string, { name: string; price: string; quota: number; features: string[]; color: string }> = {
  free: {
    name: '免费版',
    price: '¥0/月',
    quota: 50,
    features: ['每日 50 次调用', '基础空间分析', 'OSM 数据查询', '单图层导出'],
    color: '#8c8c8c',
  },
  pro: {
    name: '专业版',
    price: '¥29/月',
    quota: 200,
    features: ['每日 200 次调用', '全部空间分析工具', '时空立方体分析', 'AI 路径规划', '高清地图导出', '优先响应'],
    color: '#1677ff',
  },
  team: {
    name: '团队版',
    price: '¥99/月',
    quota: 1000,
    features: ['每日 1000 次调用', '全部专业版功能', '项目管理与共享', '团队协作', 'API 接入', '专属技术支持'],
    color: '#722ed1',
  },
};

const QUOTA_OPTIONS = [
  { label: '10 次', amount: 10, price: '¥1' },
  { label: '50 次', amount: 50, price: '¥5' },
  { label: '100 次', amount: 100, price: '¥10' },
  { label: '500 次', amount: 500, price: '¥50' },
  { label: '1000 次', amount: 1000, price: '¥100' },
];

const RechargeModal: React.FC<RechargeModalProps> = ({
  open,
  onClose,
  adminMode = false,
  adminUserId,
  adminUserEmail,
  onSuccess,
  isMobile = false,
}) => {
  const [activeTab, setActiveTab] = useState<'upgrade' | 'quota'>('upgrade');
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [quotaAmount, setQuotaAmount] = useState(100);
  const [loading, setLoading] = useState(false);

  const currentUser = useGISStore((s) => s.user);

  const displayPlan = adminMode ? null : currentUser?.plan;
  const displayQuotaDaily = adminMode ? null : (currentUser?.quota_daily ?? 50);

  const handleUpgrade = useCallback(() => {
    const plan = selectedPlan;
    if (!plan) {
      message.warning('请选择要升级的套餐');
      return;
    }
    const planName = PLAN_CONFIG[plan]?.name || plan;

    Modal.confirm({
      title: adminMode ? `确认升级 ${adminUserEmail} 的套餐` : '确认升级套餐',
      content: (
        <div>
          <p>即将{adminMode ? `将 ${adminUserEmail} 的套餐` : '将您的套餐'}升级至 <b>{planName}</b></p>
          <p style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
            💡 模拟支付，点击确认即完成升级
          </p>
        </div>
      ),
      okText: '确认升级',
      cancelText: '取消',
      onOk: async () => {
        setLoading(true);
        try {
          const token = useGISStore.getState().authToken;
          const url = adminMode
            ? `${API_BASE}/api/admin/users/${adminUserId}/upgrade`
            : `${API_BASE}/api/recharge/upgrade`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ plan }),
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `请求失败 (${resp.status})`);
          }
          const data = await resp.json();
          if (!adminMode) {
            useGISStore.getState().setUser(data.user);
          }
          message.success(data.message || '升级成功');
          onSuccess?.();
          onClose();
        } catch (err) {
          message.error(err instanceof Error ? err.message : '升级失败');
        } finally {
          setLoading(false);
        }
      },
    });
  }, [selectedPlan, adminMode, adminUserId, adminUserEmail, onSuccess, onClose]);

  const handleRechargeQuota = useCallback(() => {
    if (quotaAmount <= 0) {
      message.warning('请输入充值数量');
      return;
    }

    Modal.confirm({
      title: adminMode ? `确认为 ${adminUserEmail} 充值配额` : '确认充值配额',
      content: (
        <div>
          <p>即将{adminMode ? `为 ${adminUserEmail} ` : ''}增加 <b>{quotaAmount} 次</b>每日配额</p>
          <p style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
            💡 模拟支付，点击确认即完成充值
          </p>
        </div>
      ),
      okText: '确认充值',
      cancelText: '取消',
      onOk: async () => {
        setLoading(true);
        try {
          const token = useGISStore.getState().authToken;
          const url = adminMode
            ? `${API_BASE}/api/admin/users/${adminUserId}/quota`
            : `${API_BASE}/api/recharge/quota`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ amount: quotaAmount }),
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `请求失败 (${resp.status})`);
          }
          const data = await resp.json();
          if (!adminMode) {
            useGISStore.getState().setUser(data.user);
          }
          message.success(data.message || '充值成功');
          onSuccess?.();
          onClose();
        } catch (err) {
          message.error(err instanceof Error ? err.message : '充值失败');
        } finally {
          setLoading(false);
        }
      },
    });
  }, [quotaAmount, adminMode, adminUserId, adminUserEmail, onSuccess, onClose]);

  return (
    <Modal
      title={
        <span>
          <CrownOutlined style={{ color: '#faad14', marginRight: 8 }} />
          {adminMode ? `为 ${adminUserEmail} 充值` : '充值 / 升级'}
        </span>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={isMobile ? '95%' : 560}
      destroyOnClose
    >
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'upgrade' | 'quota')}
        items={[
          {
            key: 'upgrade',
            label: (
              <span>
                <CrownOutlined /> 升级套餐
              </span>
            ),
            children: (
              <div>
                {adminMode && (
                  <p style={{ color: '#999', marginBottom: 16 }}>
                    当前为 {adminUserEmail} 选择套餐
                  </p>
                )}
                <Row gutter={[12, 12]}>
                  {Object.entries(PLAN_CONFIG).map(([key, config]) => {
                    const isCurrent = !adminMode && displayPlan === key;
                    const isSelected = selectedPlan === key;
                    return (
                      <Col span={isMobile ? 24 : 8} key={key}>
                        <Card
                          size="small"
                          hoverable={!isCurrent}
                          style={{
                            border: isSelected ? `2px solid ${config.color}` : isCurrent ? '2px solid #d9d9d9' : '1px solid #f0f0f0',
                            cursor: isCurrent ? 'default' : 'pointer',
                            opacity: isCurrent ? 0.6 : 1,
                            height: '100%',
                          }}
                          onClick={() => {
                            if (!isCurrent) setSelectedPlan(key);
                          }}
                          title={
                            <div style={{ textAlign: 'center', position: 'relative' }}>
                              <span style={{ fontWeight: 700, color: config.color, fontSize: 15 }}>
                                {config.name}
                              </span>
                              {isCurrent && (
                                <Tag color="default" style={{ position: 'absolute', top: -8, right: -8, fontSize: 10 }}>
                                  当前套餐
                                </Tag>
                              )}
                              {isSelected && !isCurrent && (
                                <CheckCircleFilled style={{ position: 'absolute', top: -6, right: -6, color: config.color, fontSize: 18 }} />
                              )}
                            </div>
                          }
                        >
                          <div style={{ textAlign: 'center', marginBottom: 8 }}>
                            <span style={{ fontSize: 20, fontWeight: 700, color: config.color }}>{config.price}</span>
                          </div>
                          <div style={{ textAlign: 'center', marginBottom: 8 }}>
                            <ThunderboltOutlined style={{ color: config.color, marginRight: 4 }} />
                            <span style={{ fontWeight: 600 }}>{config.quota} 次/天</span>
                          </div>
                          <ul style={{ paddingLeft: 16, fontSize: 12, color: '#666', margin: 0 }}>
                            {config.features.map((f, i) => (
                              <li key={i} style={{ marginBottom: 2 }}>{f}</li>
                            ))}
                          </ul>
                        </Card>
                      </Col>
                    );
                  })}
                </Row>
                <div style={{ marginTop: 20, textAlign: 'center' }}>
                  <Button
                    type="primary"
                    size="large"
                    icon={<CrownOutlined />}
                    loading={loading}
                    disabled={!selectedPlan}
                    onClick={handleUpgrade}
                    style={{ minWidth: 160 }}
                  >
                    确认升级
                  </Button>
                </div>
              </div>
            ),
          },
          {
            key: 'quota',
            label: (
              <span>
                <ThunderboltOutlined /> 充值配额
              </span>
            ),
            children: (
              <div>
                {!adminMode && (
                  <div style={{ textAlign: 'center', marginBottom: 20, padding: '12px', background: '#f5f5f5', borderRadius: 8 }}>
                    <span style={{ color: '#999' }}>当前每日配额：</span>
                    <span style={{ fontSize: 24, fontWeight: 700, color: '#1677ff' }}>{displayQuotaDaily}</span>
                    <span style={{ color: '#999' }}> 次</span>
                  </div>
                )}
                {adminMode && (
                  <p style={{ color: '#999', marginBottom: 16 }}>
                    为 {adminUserEmail} 增加每日配额
                  </p>
                )}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ marginBottom: 8, fontWeight: 500 }}>快捷选择：</div>
                  <Space wrap>
                    {QUOTA_OPTIONS.map((opt) => (
                      <Button
                        key={opt.amount}
                        type={quotaAmount === opt.amount ? 'primary' : 'default'}
                        onClick={() => setQuotaAmount(opt.amount)}
                        size={isMobile ? 'middle' : 'middle'}
                      >
                        {opt.label}
                        <span style={{ fontSize: 11, color: quotaAmount === opt.amount ? 'rgba(255,255,255,0.7)' : '#999', marginLeft: 4 }}>
                          ({opt.price})
                        </span>
                      </Button>
                    ))}
                  </Space>
                </div>
                <div style={{ marginBottom: 20 }}>
                  <span style={{ marginRight: 8, fontWeight: 500 }}>自定义数量：</span>
                  <InputNumber
                    min={1}
                    max={100000}
                    value={quotaAmount}
                    onChange={(v) => setQuotaAmount(v || 1)}
                    addonAfter="次"
                    style={{ width: 160 }}
                  />
                </div>
                <div style={{ textAlign: 'center' }}>
                  <Button
                    type="primary"
                    size="large"
                    icon={<ThunderboltOutlined />}
                    loading={loading}
                    onClick={handleRechargeQuota}
                    style={{ minWidth: 160 }}
                  >
                    确认充值
                  </Button>
                </div>
              </div>
            ),
          },
        ]}
      />
    </Modal>
  );
};

export default RechargeModal;
