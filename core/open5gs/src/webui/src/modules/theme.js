import { createAction } from 'redux-actions';
import { handleActions } from 'redux-actions';

export const THEME = {
  TOGGLE: 'theme/TOGGLE',
  SET: 'theme/SET'
};

export const toggleTheme = createAction(THEME.TOGGLE);
export const setTheme = createAction(THEME.SET);

const initialState = {
  isDarkMode: false
};

export default handleActions({
  [THEME.TOGGLE]: (state) => {
    var next = !state.isDarkMode;
    if (typeof window !== 'undefined') {
      localStorage.setItem('open5gs_dark_mode', String(next));
    }
    return { ...state, isDarkMode: next };
  },
  [THEME.SET]: (state, action) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('open5gs_dark_mode', String(action.payload));
    }
    return { ...state, isDarkMode: action.payload };
  }
}, initialState);
