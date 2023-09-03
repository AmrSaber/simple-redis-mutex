module.exports = {
  extends: ['airbnb-base', 'prettier'],
  parserOptions: {
    sourceType: 'module',
    ecmaVersion: 9,
  },
  env: {
    es6: true,
    node: true,
    jest: true,
  },
  rules: {
    // closed from airbnb
    'func-names': 'off',
    'consistent-return': 'off',
    'no-underscore-dangle': 'off',
    'import/prefer-default-export': 'off',

    'no-unused-vars': [
      'error',
      {
        vars: 'all',
        varsIgnorePattern: '^Promise$',
        args: 'none',
        ignoreRestSiblings: true,
      },
    ],

    'no-plusplus': 'off',
  },
};
