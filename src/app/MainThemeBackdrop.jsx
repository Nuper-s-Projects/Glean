import { useLayoutEffect } from 'react';
import { mainThemeBackdropStyle, selectedMainTheme } from './mainTheme';

export default function MainThemeBackdrop({ preferences, enabled }) {
  const theme = enabled ? selectedMainTheme(preferences) : null;
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('glean-themed-main', Boolean(theme));
    return () => document.documentElement.classList.remove('glean-themed-main');
  }, [Boolean(theme)]);
  return theme ? <div className="glean-theme-backdrop" aria-hidden="true" style={mainThemeBackdropStyle(theme)} /> : null;
}
