import { LOCAL_DICT } from './constants.js';

export function L(text: string): string {
    const lang = localStorage.getItem('language') || 'en';
    if (lang.startsWith('zh') && LOCAL_DICT[text]) {
        return LOCAL_DICT[text];
    }
    return text;
}
