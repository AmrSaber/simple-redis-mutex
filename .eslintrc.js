module.exports = {
    extends: 'airbnb-base',
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

        // overridden from airbnb
        curly: ['error', 'all'],

        indent: ['error', 2, { 'SwitchCase': 1 }],

        'no-unused-vars': [
            'error',
            {
                vars: 'all',
                varsIgnorePattern: '^Promise$',
                args: 'none',
                ignoreRestSiblings: true,
            },
        ],

        'max-len': [
            'error',
            120,
            2,
            {
                ignoreUrls: true,
                ignoreComments: false,
                ignoreRegExpLiterals: true,
                ignoreStrings: true,
                ignoreTemplateLiterals: true,
            }
        ],

        'object-curly-newline': ['error', {
            'multiline': true,
            'consistent': true,
        }],

        'no-plusplus': 'off',

        'arrow-parens': ['error', 'as-needed']
    },
};
