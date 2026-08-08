import { chat_completion_sources } from '@sillytavern/scripts/openai';

export let EXTENSION_NAME = 'preset-cards';
try {
    const url = new URL(import.meta.url);
    const match = url.pathname.match(/\/scripts\/extensions\/(.*?)\/(?:dist\/)?index\.js/);
    if (match) EXTENSION_NAME = match[1];
} catch (e) {
    console.warn('preset-cards: could not determine extension path', e);
}

export const EXTENSION_KEY = 'preset_cards';
export const LOGO_BASE = `/scripts/extensions/${EXTENSION_NAME}/llm-logos/`;

export const LOCAL_DICT: Record<string, string> = {
    'Configurations': '配置快照',
    'Save current state as new configuration': '将当前状态保存为新配置',
    'Overwrite with current settings': '覆盖为当前设置',
    'Rename': '重命名',
    'Delete': '删除',
    'Load configuration': '加载该配置',
    'Configuration name:': '配置名称：',
    'e.g., GPT-4 Optimization': '例如：GPT-4 优化版',
    'Overwrite this configuration with current settings?': '是否用当前的设置覆盖此配置？',
    'Configuration updated': '配置已更新',
    'Saving current preset state...': '正在保存当前预设状态...',
    'Applicable Models': '适用模型',
    'Add a short description for this preset...': '为该预设添加一段简短的描述...',
    'Description': '描述',
    'Search presets...': '搜索预设...',
    'Multi-Select': '多选',
    'Batch Delete': '批量删除',
    'Import Preset': '导入预设',
    'Export configuration': '导出配置',
    'Import configuration': '导入配置',
    'Failed to parse configuration file': '无法解析配置文件',
    'Concise Mode': '简洁模式',
    'No configurations saved for this preset': '该预设没有配置快照',
    'Background Image URL': '背景图片链接',
    'e.g., https://example.com/bg.jpg': '例如：https://example.com/bg.jpg',
    'Clear Cache': '清理缓存',
    'Clear all cached background images?': '确定要清理所有已缓存的背景图片吗？',
    'Cache cleared successfully': '缓存清理成功',
};

export interface ModelDef {
    id: string;
    label: string;
    logo: string;
}

export const AVAILABLE_MODELS: ModelDef[] = [
    { id: 'claude',   label: 'Claude',   logo: 'claude-color.png'   },
    { id: 'gemini',   label: 'Gemini',   logo: 'gemini-color.png'   },
    { id: 'deepseek', label: 'DeepSeek', logo: 'deepseek-color.png' },
    { id: 'chatglm',  label: 'ChatGLM',  logo: 'chatglm-color.png'  },
    { id: 'grok',     label: 'Grok',     logo: 'grok.png'           },
    { id: 'kimi',     label: 'Kimi',     logo: 'kimi-color.png'     },
];

/** Map model id → full logo URL */
export const MODEL_LOGO_MAP: Record<string, string> = Object.fromEntries(
    AVAILABLE_MODELS.map(m => [m.id, LOGO_BASE + m.logo]),
);

/** Friendly labels for chat completion sources */
export const SOURCE_LABELS: Record<string, string> = {
    [chat_completion_sources.OPENAI]: 'OpenAI',
    [chat_completion_sources.CLAUDE]: 'Claude',
    [chat_completion_sources.OPENROUTER]: 'OpenRouter',
    [chat_completion_sources.AI21]: 'AI21',
    [chat_completion_sources.MAKERSUITE]: 'Google AI',
    [chat_completion_sources.VERTEXAI]: 'Vertex AI',
    [chat_completion_sources.MISTRALAI]: 'Mistral AI',
    [chat_completion_sources.CUSTOM]: 'Custom',
    [chat_completion_sources.COHERE]: 'Cohere',
    [chat_completion_sources.PERPLEXITY]: 'Perplexity',
    [chat_completion_sources.GROQ]: 'Groq',
    [chat_completion_sources.ELECTRONHUB]: 'ElectronHub',
    [chat_completion_sources.CHUTES]: 'Chutes',
    [chat_completion_sources.NANOGPT]: 'NanoGPT',
    [chat_completion_sources.DEEPSEEK]: 'DeepSeek',
    [chat_completion_sources.AIMLAPI]: 'AIML API',
    [chat_completion_sources.XAI]: 'xAI',
    [chat_completion_sources.POLLINATIONS]: 'Pollinations',
    [chat_completion_sources.MOONSHOT]: 'Moonshot',
    [chat_completion_sources.FIREWORKS]: 'Fireworks',
    [chat_completion_sources.COMETAPI]: 'CometAPI',
    [chat_completion_sources.AZURE_OPENAI]: 'Azure OpenAI',
    [chat_completion_sources.ZAI]: 'ZhipuAI',
    [chat_completion_sources.SILICONFLOW]: 'SiliconFlow',
    [chat_completion_sources.WORKERS_AI]: 'Workers AI',
    [chat_completion_sources.MINIMAX]: 'MiniMax',
};

/** Source → logo mapping (reuses the logos that match) */
export const SOURCE_LOGO_MAP: Record<string, string> = {
    [chat_completion_sources.CLAUDE]: MODEL_LOGO_MAP['claude'],
    [chat_completion_sources.MAKERSUITE]: MODEL_LOGO_MAP['gemini'],
    [chat_completion_sources.VERTEXAI]: MODEL_LOGO_MAP['gemini'],
    [chat_completion_sources.DEEPSEEK]: MODEL_LOGO_MAP['deepseek'],
    [chat_completion_sources.ZAI]: MODEL_LOGO_MAP['chatglm'],
    [chat_completion_sources.XAI]: MODEL_LOGO_MAP['grok'],
    [chat_completion_sources.MOONSHOT]: MODEL_LOGO_MAP['kimi'],
};

/** Keys in the preset object that map to a model name for each source */
export const MODEL_KEYS: Record<string, string> = {
    [chat_completion_sources.OPENAI]: 'openai_model',
    [chat_completion_sources.CLAUDE]: 'claude_model',
    [chat_completion_sources.OPENROUTER]: 'openrouter_model',
    [chat_completion_sources.AI21]: 'ai21_model',
    [chat_completion_sources.MAKERSUITE]: 'google_model',
    [chat_completion_sources.VERTEXAI]: 'vertexai_model',
    [chat_completion_sources.MISTRALAI]: 'mistralai_model',
    [chat_completion_sources.CUSTOM]: 'custom_model',
    [chat_completion_sources.COHERE]: 'cohere_model',
    [chat_completion_sources.PERPLEXITY]: 'perplexity_model',
    [chat_completion_sources.GROQ]: 'groq_model',
    [chat_completion_sources.ELECTRONHUB]: 'electronhub_model',
    [chat_completion_sources.CHUTES]: 'chutes_model',
    [chat_completion_sources.NANOGPT]: 'nanogpt_model',
    [chat_completion_sources.DEEPSEEK]: 'deepseek_model',
    [chat_completion_sources.AIMLAPI]: 'aimlapi_model',
    [chat_completion_sources.XAI]: 'xai_model',
    [chat_completion_sources.POLLINATIONS]: 'pollinations_model',
    [chat_completion_sources.MOONSHOT]: 'moonshot_model',
    [chat_completion_sources.FIREWORKS]: 'fireworks_model',
    [chat_completion_sources.COMETAPI]: 'cometapi_model',
    [chat_completion_sources.AZURE_OPENAI]: 'azure_openai_model',
    [chat_completion_sources.ZAI]: 'zai_model',
    [chat_completion_sources.SILICONFLOW]: 'siliconflow_model',
    [chat_completion_sources.WORKERS_AI]: 'workers_ai_model',
    [chat_completion_sources.MINIMAX]: 'minimax_model',
};
