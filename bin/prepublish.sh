if [[ $(git status -s) ]]; then
  echo 'There are uncommitted changes!'
  echo
  exit 1
fi

echo 'Have you updated these things:'
read -p '- changelog'
read -p '- readme.md documentation link'
read -p '- package.js version'
echo
read -p 'Have you committed these changes?'
read -p 'Have you published the release in GitHub?'

npm run build

read -p 'Ready to publish?'
