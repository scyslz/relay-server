export type ThemeMode = 'dark' | 'light' | 'midnight';

export interface ThemeStyles {
  appBg: string;
  headerBg: string;
  headerBorder: string;
  headerText: string;
  cardBg: string;
  cardBorder: string;
  cardHover: string;
  cardSelected: string;
  inputBg: string;
  inputBorder: string;
  inputText: string;
  inputPlaceholder: string;
  codeBg: string;
  codeBorder: string;
  codeText: string;
  textPrimary: string;
  textMuted: string;
  textSecondary: string;
  borderSubtle: string;
  badgeBg: string;
  badgeText: string;
  modalBg: string;
  modalBorder: string;
  overlayBg: string;
  panelBg: string;
  buttonSecondary: string;
}

export const THEME_STYLES: Record<ThemeMode, ThemeStyles> = {
  dark: {
    appBg: 'bg-slate-950 text-slate-100',
    headerBg: 'bg-slate-900/95 border-slate-800 text-slate-100',
    headerBorder: 'border-slate-800',
    headerText: 'text-slate-100',
    cardBg: 'bg-slate-900',
    cardBorder: 'border-slate-800',
    cardHover: 'hover:bg-slate-800/80 hover:border-slate-700',
    cardSelected: 'bg-indigo-950/40 border-indigo-500/80 ring-1 ring-indigo-500/50',
    inputBg: 'bg-slate-800',
    inputBorder: 'border-slate-700 focus:border-indigo-500',
    inputText: 'text-slate-100',
    inputPlaceholder: 'placeholder-slate-500',
    codeBg: 'bg-slate-950',
    codeBorder: 'border-slate-800',
    codeText: 'text-slate-300',
    textPrimary: 'text-slate-100',
    textMuted: 'text-slate-400',
    textSecondary: 'text-slate-300',
    borderSubtle: 'border-slate-800',
    badgeBg: 'bg-slate-800',
    badgeText: 'text-slate-300',
    modalBg: 'bg-slate-900',
    modalBorder: 'border-slate-800',
    overlayBg: 'bg-slate-950/80',
    panelBg: 'bg-slate-950',
    buttonSecondary: 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700',
  },
  light: {
    appBg: 'bg-slate-100 text-slate-900',
    headerBg: 'bg-white/95 border-slate-200 text-slate-900 shadow-sm',
    headerBorder: 'border-slate-200',
    headerText: 'text-slate-900',
    cardBg: 'bg-white',
    cardBorder: 'border-slate-200 shadow-sm',
    cardHover: 'hover:bg-slate-50 hover:border-indigo-300',
    cardSelected: 'bg-indigo-50/90 border-indigo-500 ring-1 ring-indigo-500/50 shadow-sm',
    inputBg: 'bg-slate-50',
    inputBorder: 'border-slate-300 focus:border-indigo-600',
    inputText: 'text-slate-900',
    inputPlaceholder: 'placeholder-slate-400',
    codeBg: 'bg-slate-900',
    codeBorder: 'border-slate-800',
    codeText: 'text-slate-100',
    textPrimary: 'text-slate-900',
    textMuted: 'text-slate-500',
    textSecondary: 'text-slate-700',
    borderSubtle: 'border-slate-200',
    badgeBg: 'bg-slate-200',
    badgeText: 'text-slate-800',
    modalBg: 'bg-white',
    modalBorder: 'border-slate-200',
    overlayBg: 'bg-slate-900/60',
    panelBg: 'bg-slate-50',
    buttonSecondary: 'bg-slate-100 hover:bg-slate-200 text-slate-800 border-slate-300',
  },
  midnight: {
    appBg: 'bg-black text-slate-100',
    headerBg: 'bg-zinc-950/95 border-zinc-800 text-slate-100',
    headerBorder: 'border-zinc-800',
    headerText: 'text-zinc-100',
    cardBg: 'bg-zinc-950',
    cardBorder: 'border-zinc-800',
    cardHover: 'hover:bg-zinc-900/90 hover:border-cyan-700/60',
    cardSelected: 'bg-cyan-950/30 border-cyan-500/80 ring-1 ring-cyan-500/50',
    inputBg: 'bg-zinc-900',
    inputBorder: 'border-zinc-800 focus:border-cyan-500',
    inputText: 'text-slate-100',
    inputPlaceholder: 'placeholder-zinc-500',
    codeBg: 'bg-black',
    codeBorder: 'border-zinc-800',
    codeText: 'text-cyan-300',
    textPrimary: 'text-zinc-100',
    textMuted: 'text-zinc-400',
    textSecondary: 'text-zinc-300',
    borderSubtle: 'border-zinc-800',
    badgeBg: 'bg-zinc-900',
    badgeText: 'text-zinc-300',
    modalBg: 'bg-zinc-950',
    modalBorder: 'border-zinc-800',
    overlayBg: 'bg-black/80',
    panelBg: 'bg-black',
    buttonSecondary: 'bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border-zinc-800',
  },
};
