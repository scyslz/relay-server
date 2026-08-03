import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { ThemeMode } from '../types';
import { THEME_STYLES } from '../theme';

export interface SelectOption {
  value: string;
  label: string;
  subtitle?: string;
  badge?: string;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  buttonClassName?: string;
  dropdownClassName?: string;
  dropdownAlign?: 'left' | 'right' | 'stretch';
  disabled?: boolean;
  theme?: ThemeMode;
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  options,
  onChange,
  placeholder = 'Select...',
  className = '',
  buttonClassName = '',
  dropdownClassName = '',
  dropdownAlign = 'stretch',
  disabled = false,
  theme = 'dark'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const styles = THEME_STYLES[theme];

  const selectedOption = options.find(o => o.value === value);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const alignClass =
    dropdownAlign === 'right'
      ? 'right-0 left-auto min-w-[240px] max-w-[380px]'
      : dropdownAlign === 'left'
      ? 'left-0 right-auto min-w-[240px] max-w-[380px]'
      : 'left-0 right-0 min-w-[140px]';

  return (
    <div ref={containerRef} className={`relative inline-block text-left ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 sm:py-1 text-xs font-medium ${styles.inputBg} hover:opacity-90 ${styles.inputText} rounded-lg border ${styles.inputBorder} shadow-sm focus:outline-none focus:border-indigo-500 transition-all ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        } ${buttonClassName}`}
      >
        <span className="truncate text-left font-sans">
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 ${styles.textMuted} shrink-0 transition-transform duration-150 ${isOpen ? 'rotate-180 text-indigo-400' : ''}`} />
      </button>

      {isOpen && (
        <div className={`absolute z-50 mt-1 max-h-64 overflow-y-auto rounded-xl ${styles.cardBg} border ${styles.inputBorder} shadow-2xl py-1 text-xs ${styles.inputText} divide-y divide-slate-700/40 focus:outline-none scrollbar-thin scrollbar-thumb-slate-700 ${alignClass} ${dropdownClassName}`}>
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                className={`w-full text-left px-3 py-2 sm:py-1.5 flex items-center justify-between gap-2 transition-colors ${
                  isSelected
                    ? 'bg-indigo-600/25 text-indigo-300 font-semibold'
                    : `${styles.textSecondary} hover:bg-indigo-500/10`
                }`}
              >
                <div className="flex flex-col min-w-0">
                  <span className="truncate">{option.label}</span>
                  {option.subtitle && (
                    <span className={`text-[10px] ${styles.textMuted} font-mono truncate`}>{option.subtitle}</span>
                  )}
                </div>
                {option.badge && (
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${styles.badgeBg} ${styles.badgeText} shrink-0`}>
                    {option.badge}
                  </span>
                )}
                {isSelected && <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0 ml-auto" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
