// Tradução da interface. O texto em português é a própria chave; o dicionário
// inglês fica em i18n-en.ts. O teste i18n.test.ts confere que toda chave usada
// com t('…') no código tem tradução.

import { EN } from './i18n-en'

export type Lang = 'pt' | 'en'

/** Lida já no carregamento, para que tabelas montadas no início saiam na língua certa. */
function initialLang(): Lang {
  try {
    const saved = JSON.parse(localStorage.getItem('aracua.settings') ?? '{}').lang
    if (saved === 'pt' || saved === 'en') return saved
  } catch {
    /* sem armazenamento */
  }
  return typeof navigator !== 'undefined' && !navigator.language?.toLowerCase().startsWith('pt') ? 'en' : 'pt'
}

let lang: Lang = initialLang()

export function setLang(l: Lang) {
  lang = l
  if (typeof document !== 'undefined') document.documentElement.lang = l === 'pt' ? 'pt-BR' : 'en'
}

export function getLang(): Lang {
  return lang
}

/** Texto na língua escolhida; `{nome}` é trocado por `vars.nome`. */
export function t(s: string, vars?: Record<string, string | number>): string {
  let out = lang === 'en' ? EN[s] ?? s : s
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
  return out
}

/** Marca um texto para tradução sem traduzir agora (tabelas montadas no carregamento). */
export const tk = (s: string) => s

/** Número no formato da língua (vírgula decimal em português). */
export function num(v: number, digits = 1): string {
  return v.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
