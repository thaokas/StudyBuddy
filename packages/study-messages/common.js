/**
 * Copy shared by every study page. Page-specific copy lives in the dictionary
 * module named after that page; the client entry merges both into the `study`
 * namespace.
 */
export default {
  en: {
    'common.linkedWorkspaces': 'Linked workspaces',
    'common.noLinkedWorkspaces': 'No linked workspace',
    'common.workspaceMissing': 'Workspace unavailable',
    'common.refresh': 'Refresh',
    'common.loading': 'Loading study data…',
    'common.empty': 'No study data yet.',
    'common.error': 'Could not load study data: {message}',
    'common.networkError': 'the study service is unreachable',
  },
  zh: {
    'common.linkedWorkspaces': '关联工作区',
    'common.noLinkedWorkspaces': '未关联工作区',
    'common.workspaceMissing': '工作区已不可用',
    'common.refresh': '刷新',
    'common.loading': '正在读取学习数据…',
    'common.empty': '还没有学习数据。',
    'common.error': '读取学习数据失败：{message}',
    'common.networkError': '无法连接学习服务',
  },
};
