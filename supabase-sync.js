/**
 * 需求模块 3：Supabase JSONB 存储与防覆盖（乐观锁）
 * 
 * 功能：
 * 1. Supabase 初始化（从环境变量或全局配置读取）
 * 2. 前端数据结构打包为 JSONB
 * 3. 防多设备覆盖：乐观锁机制
 *    - 保存前拉取云端 updated_at
 *    - 对比本地最后保存时间
 *    - 若云端更新则拦截并提示刷新
 *    - 若本地最新则 upsert 更新云端 updated_at
 */

// ========== 配置与初始化 ==========

const SupabaseConfig = {
  url: process.env.SUPABASE_URL || window.SUPABASE_URL || '',
  anonKey: process.env.SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY || '',
  tableName: 'phone_numbers_state',
  userId: localStorage.getItem('userId') || 'anonymous'
};

// 验证 Supabase 配置
function validateSupabaseConfig() {
  if (!SupabaseConfig.url || !SupabaseConfig.anonKey) {
    console.warn('⚠️ Supabase 配置未完成，功能降级为本地存储');
    return false;
  }
  console.log('✅ Supabase 配置已加载');
  return true;
}

// ========== 数据结构定义 ==========

/**
 * 前端状态打包结构
 */
class AppStatePackage {
  constructor() {
    this.id = SupabaseConfig.userId; // 用户 ID 作为主键
    this.phoneNumbers = []; // 号码数组
    this.groups = {}; // 分组信息
    this.lastLocalSaveTime = null; // 本地最后保存时间
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
  }

  /**
   * 从前端 UI 收集所有数据
   */
  collectFromUI() {
    // 收集号码数据
    const tableBody = document.getElementById('tableBody');
    this.phoneNumbers = [];
    
    if (tableBody) {
      const rows = tableBody.querySelectorAll('tr');
      rows.forEach((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length > 1 && cells[2]?.textContent) {
          this.phoneNumbers.push({
            number: cells[2].textContent.trim(),
            remark: cells[3]?.textContent.trim() || '',
            group: cells[4]?.textContent.trim() || '未分组'
          });
        }
      });
    }

    // 收集分组信息
    const groupTabs = document.getElementById('groupTabs');
    if (groupTabs) {
      const groupMatches = groupTabs.textContent.match(/(\S+)\s*\((\d+)\)/g);
      if (groupMatches) {
        this.groups = {};
        groupMatches.forEach((match) => {
          const [groupName, count] = match.match(/(\S+)\s*\((\d+)\)/);
          this.groups[groupName] = parseInt(count);
        });
      }
    }

    // 更新本地保存时间
    this.lastLocalSaveTime = new Date().toISOString();
    this.updatedAt = this.lastLocalSaveTime;

    return this;
  }

  /**
   * 转换为 Supabase JSONB 格式
   */
  toJSON() {
    return {
      id: this.id,
      user_data: {
        phoneNumbers: this.phoneNumbers,
        groups: this.groups,
        lastLocalSaveTime: this.lastLocalSaveTime,
        statistics: {
          totalCount: this.phoneNumbers.length,
          validCount: this.phoneNumbers.filter(p => p.number).length,
          duplicateCount: this.calculateDuplicates()
        }
      },
      created_at: this.createdAt,
      updated_at: this.updatedAt
    };
  }

  /**
   * 计算重复号码数量
   */
  calculateDuplicates() {
    const numbers = this.phoneNumbers.map(p => p.number);
    const counted = new Set();
    let duplicateCount = 0;

    numbers.forEach((num) => {
      if (counted.has(num)) {
        duplicateCount++;
      } else {
        counted.add(num);
      }
    });

    return duplicateCount;
  }
}

// ========== Supabase 核心操作函数 ==========

/**
 * 初始化 Supabase 客户端
 * 
 * 使用方式：
 * 方案 A（推荐）：通过 supabase-js 库
 * const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
 * 
 * 方案 B（简化）：直接使用 REST API
 */
async function initSupabaseClient() {
  try {
    // 检查配置
    if (!validateSupabaseConfig()) {
      console.warn('❌ Supabase 配置无效，使用本地存储');
      return null;
    }

    // 如果已加载 @supabase/supabase-js 库
    if (window.supabase) {
      const { createClient } = window.supabase;
      return createClient(SupabaseConfig.url, SupabaseConfig.anonKey);
    }

    // 否则返回 REST API 适配器
    console.log('ℹ️ 使用 REST API 与 Supabase 交互');
    return {
      from: (table) => ({
        table,
        select: async (fields = '*') => new SupabaseRESTAdapter(table, 'SELECT', fields),
        upsert: async (data) => new SupabaseRESTAdapter(table, 'UPSERT', null, data),
        update: async (data) => new SupabaseRESTAdapter(table, 'UPDATE', null, data)
      })
    };
  } catch (error) {
    console.error('❌ Supabase 初始化失败:', error);
    return null;
  }
}

/**
 * REST API 适配器类（轻量级实现）
 */
class SupabaseRESTAdapter {
  constructor(table, operation, fields, data) {
    this.table = table;
    this.operation = operation;
    this.fields = fields;
    this.data = data;
    this.url = `${SupabaseConfig.url}/rest/v1/${table}`;
    this.headers = {
      'apikey': SupabaseConfig.anonKey,
      'Authorization': `Bearer ${SupabaseConfig.anonKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };
  }

  /**
   * 执行 SELECT 查询
   */
  async eq(column, value) {
    try {
      const query = `${this.url}?${column}=eq.${encodeURIComponent(value)}&select=${this.fields || '*'}`;
      const response = await fetch(query, {
        method: 'GET',
        headers: this.headers
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return { data, error: null };
    } catch (error) {
      console.error('❌ SELECT 查询失败:', error);
      return { data: null, error };
    }
  }

  /**
   * 执行 UPSERT 操作
   */
  async execute() {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          ...this.headers,
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(this.data)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return { data, error: null };
    } catch (error) {
      console.error('❌ UPSERT 操作失败:', error);
      return { data: null, error };
    }
  }
}

// ========== 防覆盖机制（乐观锁）==========

// 云端最后更新时间戳（内存缓存）
let cloudLastUpdateTime = null;

/**
 * 从云端拉取 updated_at 时间戳
 * 用于乐观锁检测
 */
async function fetchCloudTimestamp() {
  const supabase = await initSupabaseClient();
  
  if (!supabase) {
    console.warn('⚠️ Supabase 未初始化，跳过时间戳检查');
    return null;
  }

  try {
    // 使用 REST API 查询
    const adapter = new SupabaseRESTAdapter(
      SupabaseConfig.tableName,
      'SELECT',
      'updated_at'
    );
    const { data, error } = await adapter.eq('id', SupabaseConfig.userId);

    if (error) {
      console.error('❌ 无法从云端拉取时间戳:', error);
      return null;
    }

    if (data && data.length > 0) {
      cloudLastUpdateTime = data[0].updated_at;
      console.log('✅ 云端时间戳已同步:', cloudLastUpdateTime);
      return cloudLastUpdateTime;
    }

    // 首次保存，云端无数据
    console.log('ℹ️ 首次保存，云端无历史数据');
    return null;
  } catch (error) {
    console.error('❌ 拉取时间戳异常:', error);
    return null;
  }
}

/**
 * 对比本地与云端时间戳
 * 检测是否有其他设备的更新
 * 
 * 返回值：
 *   - 'safe': 本地最新，可以保存
 *   - 'conflict': 云端更新，需要刷新
 *   - 'unknown': 无法判断，询问用户
 */
async function validateSavePermission(localSaveTime) {
  // 若云端时间戳未初始化，先拉取
  if (cloudLastUpdateTime === null) {
    await fetchCloudTimestamp();
  }

  // 若云端仍无数据（首次保存）
  if (cloudLastUpdateTime === null) {
    console.log('✅ 首次保存，无冲突');
    return 'safe';
  }

  // 解析时间戳
  const localTime = new Date(localSaveTime).getTime();
  const cloudTime = new Date(cloudLastUpdateTime).getTime();

  // 对比：云端更新 => 冲突
  if (cloudTime > localTime) {
    console.warn('⚠️ 冲突检测：云端时间更新，有其他设备在修改');
    return 'conflict';
  }

  // 本地最新 => 允许保存
  console.log('✅ 冲突检测通过：本地最新，可以保存');
  return 'safe';
}

// ========== UPSERT 写入函数 ==========

/**
 * 执行 UPSERT 操作：将本地数据写入 Supabase
 * 
 * 流程：
 * 1. 打包前端数据为 JSONB
 * 2. 执行冲突检测（乐观锁）
 * 3. 若无冲突，执行 UPSERT
 * 4. 更新本地云端时间戳缓存
 */
async function performUpsert() {
  try {
    console.log('🔄 开始 UPSERT 操作...');

    // Step 1: 打包数据
    const appState = new AppStatePackage();
    appState.collectFromUI();
    const payload = appState.toJSON();

    // Step 2: 冲突检测
    const permission = await validateSavePermission(appState.lastLocalSaveTime);
    
    if (permission === 'conflict') {
      const errorMsg = '数据已在其他设备更新，请刷新';
      console.error('❌ ' + errorMsg);
      
      // 弹窗提示用户
      showConflictDialog(errorMsg);
      return {
        success: false,
        error: 'CONFLICT',
        message: errorMsg
      };
    }

    if (permission === 'unknown') {
      console.warn('⚠️ 无法判断冲突状态，继续保存');
    }

    // Step 3: 执行 UPSERT
    const supabase = await initSupabaseClient();
    
    if (!supabase) {
      console.warn('⚠️ Supabase 未初始化，降级为本地存储');
      saveToLocalStorage(payload);
      return {
        success: true,
        message: '已保存到本地存储（云端暂不可用）'
      };
    }

    // 构造 UPSERT 请求
    const adapter = new SupabaseRESTAdapter(
      SupabaseConfig.tableName,
      'UPSERT',
      null,
      payload
    );
    const { data, error } = await adapter.execute();

    if (error) {
      throw error;
    }

    // Step 4: 更新本地时间戳缓存
    cloudLastUpdateTime = payload.updated_at;

    console.log('✅ UPSERT 成功，云端数据已更新');
    return {
      success: true,
      data: data,
      message: '数据已同步到云端',
      cloudUpdateTime: cloudLastUpdateTime
    };
  } catch (error) {
    console.error('❌ UPSERT 失败:', error);
    return {
      success: false,
      error: error.message,
      message: '保存失败，请重试'
    };
  }
}

/**
 * 从云端读取数据
 * 用于刷新时恢复最新状态
 */
async function fetchDataFromCloud() {
  try {
    console.log('🔄 从云端拉取数据...');

    const supabase = await initSupabaseClient();
    
    if (!supabase) {
      console.warn('⚠️ Supabase 未初始化，使用本地存储');
      return getFromLocalStorage();
    }

    const adapter = new SupabaseRESTAdapter(
      SupabaseConfig.tableName,
      'SELECT',
      '*'
    );
    const { data, error } = await adapter.eq('id', SupabaseConfig.userId);

    if (error) {
      throw error;
    }

    if (data && data.length > 0) {
      const record = data[0];
      cloudLastUpdateTime = record.updated_at;
      
      console.log('✅ 云端数据已拉取');
      return {
        success: true,
        data: record.user_data,
        timestamp: record.updated_at
      };
    }

    console.log('ℹ️ 云端暂无数据');
    return {
      success: false,
      message: '云端无历史数据'
    };
  } catch (error) {
    console.error('❌ 读取云端数据失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ========== 本地存储备份 ==========

/**
 * 保存到浏览器本地存储（降级方案）
 */
function saveToLocalStorage(payload) {
  try {
    localStorage.setItem(
      `phoneNumbers_${SupabaseConfig.userId}`,
      JSON.stringify(payload)
    );
    console.log('✅ 已保存到本地存储');
  } catch (error) {
    console.error('❌ 本地存储失败:', error);
  }
}

/**
 * 从本地存储恢复
 */
function getFromLocalStorage() {
  try {
    const data = localStorage.getItem(`phoneNumbers_${SupabaseConfig.userId}`);
    if (data) {
      return {
        success: true,
        data: JSON.parse(data)
      };
    }
    return { success: false };
  } catch (error) {
    console.error('❌ 本地存储读取失败:', error);
    return { success: false };
  }
}

// ========== UI 交互 ==========

/**
 * 显示冲突提示对话框
 */
function showConflictDialog(message) {
  const dialog = document.createElement('div');
  dialog.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    border-radius: 8px;
    padding: 24px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    z-index: 10000;
    max-width: 400px;
  `;

  dialog.innerHTML = `
    <h3 style="color: #d32f2f; margin-bottom: 12px;">⚠️ 数据冲突</h3>
    <p style="color: #666; margin-bottom: 20px;">${message}</p>
    <button id="refreshBtn" style="
      padding: 10px 20px;
      background: #1976d2;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    ">刷新页面</button>
  `;

  document.body.appendChild(dialog);

  document.getElementById('refreshBtn').addEventListener('click', () => {
    location.reload();
  });
}

// ========== 导出供外部调用 ==========

window.SupabaseModule = {
  initSupabaseClient,
  validateSupabaseConfig,
  AppStatePackage,
  fetchCloudTimestamp,
  validateSavePermission,
  performUpsert,
  fetchDataFromCloud,
  saveToLocalStorage,
  getFromLocalStorage,
  showConflictDialog,
  getConfig: () => SupabaseConfig,
  setUserId: (userId) => {
    SupabaseConfig.userId = userId;
    localStorage.setItem('userId', userId);
  }
};

console.log('✅ Supabase 模块已加载');
