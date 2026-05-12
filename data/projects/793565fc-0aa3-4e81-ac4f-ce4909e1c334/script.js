import React from 'react';
import ReactDOM from 'react-dom';
import Menu from './components/Menu';
import Game from './components/Game';
import PauseMenu from './components/PauseMenu';
import StartScreen from './components/StartScreen';

const App = () => {
  const [state, setState] = React.useState('MENU');

  switch (state) {
    case 'MENU':
      return <Menu setState={setState} />;
    case 'PLAYING':
      return <Game setState={setState} />;
    case 'PAUSED':
      return <PauseMenu setState={setState} />;
    case 'GAME_OVER':
      return <StartScreen setState={setState} gameOver={true} />;
    case 'WIN':
      return <StartScreen setState={setState} gameOver={false} />;
    default:
      return <div>Invalid state</div>;
  }
};

ReactDOM.render(<App />, document.getElementById('root'));