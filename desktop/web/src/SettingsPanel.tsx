import { openCenterManagement } from './CenterGate';

export function SettingsPanel() {
  return <div className="empty-state">
    <p>模型与插件配置由中心管理。</p>
    <button type="button" onClick={openCenterManagement}>打开中心管理</button>
  </div>;
}
