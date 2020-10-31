echo 'Have you updated these things:'
read -p '- changelog'
read -p '- readme.md documentation link'
read -p '- package.js version'
echo

if [[ $(git status -s) ]]; then
  echo 'There are uncommitted changes!'
  echo
  exit 1
fi

if [[ $(git cherry -v) ]]; then
  echo 'There are upushed commits!'
  echo
  exit 1
fi

read -p 'Have you published the release in GitHub?'

npm run test
npm run build

read -p 'Ready to publish?'
