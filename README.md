## Globally Installed
> Git clone this repo
> Run the following command in the cloned directory

```
node version >= 14.0.0
npm install
npm install -g mongodb-cli (mongodb-cli : package name in package.json)
```

## For MAC
> Create a Shell Alias
### Add to your shell configuration file (~/.bashrc, ~/.zshrc, etc.):
```
alias mongosh-custom='node /full/path/to/your/repl.js'
alias msh='node /full/path/to/your/repl.js'
alias pgs='node /full/path/to/your/replPG.js'
alias pgsl-custom='node /full/path/to/your/replPG.js'
```
### Then reload your shell:
```
source ~/.bashrc  # or ~/.zshrc
```