import type { ThemeRegistration } from 'shiki';

// Two Shiki themes built from the Berthy tokens (see global.css). Every token colour keeps at
// least 4.5:1 against the code background of its mode (`--sunken`): checked in the README.
type Palette = {
  fg: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  fn: string;
  type: string;
  punct: string;
  tag: string;
};

function theme(name: string, type: 'light' | 'dark', bg: string, c: Palette): ThemeRegistration {
  return {
    name,
    type,
    colors: { 'editor.background': bg, 'editor.foreground': c.fg },
    tokenColors: [
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: c.comment } },
      {
        scope: ['keyword', 'storage', 'keyword.control', 'keyword.operator.new'],
        settings: { foreground: c.keyword },
      },
      {
        scope: ['string', 'string.quoted', 'punctuation.definition.string'],
        settings: { foreground: c.string },
      },
      {
        scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'],
        settings: { foreground: c.number },
      },
      {
        scope: ['entity.name.function', 'support.function', 'meta.function-call'],
        settings: { foreground: c.fn },
      },
      {
        scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
        settings: { foreground: c.type },
      },
      {
        scope: [
          'entity.name.tag',
          'support.type.property-name',
          'meta.object-literal.key',
          'entity.name.tag.yaml',
        ],
        settings: { foreground: c.tag },
      },
      {
        scope: ['variable', 'variable.other', 'variable.parameter'],
        settings: { foreground: c.fg },
      },
      {
        scope: ['variable.other.constant', 'support.variable', 'variable.language'],
        settings: { foreground: c.number },
      },
      {
        scope: ['punctuation', 'meta.brace', 'keyword.operator'],
        settings: { foreground: c.punct },
      },
      {
        scope: ['string.unquoted.argument', 'constant.other.option', 'variable.parameter.option'],
        settings: { foreground: c.fn },
      },
      {
        scope: ['markup.heading', 'entity.name.section'],
        settings: { foreground: c.keyword, fontStyle: 'bold' },
      },
      { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
      { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    ],
  };
}

export const berthyThemes = {
  light: theme('berthy-light', 'light', '#F3F1FA', {
    fg: '#1A1828',
    comment: '#5C5774',
    keyword: '#5B3FD9',
    string: '#157A3C',
    number: '#A8460F',
    fn: '#0A62A0',
    type: '#9B1BA8',
    punct: '#5C5774',
    tag: '#0E6F86',
  }),
  dark: theme('berthy-dark', 'dark', '#0F0D18', {
    fg: '#E8E6F5',
    comment: '#8B87A3',
    keyword: '#B5A9FF',
    string: '#86EFAC',
    number: '#FDBA74',
    fn: '#7DD3FC',
    type: '#F0ABFC',
    punct: '#A9A5C0',
    tag: '#67E8F9',
  }),
};
