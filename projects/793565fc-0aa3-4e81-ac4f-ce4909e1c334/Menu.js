import React from 'react';

const Menu = ({ setState }) => {
  return (
    <div>
      <h1>DarkSpaceChess</h1>
      <button onClick={() => setState('PLAYING')}>Play</button>
      <button onClick={() => console.log('Options')}>Options</button>
      <button onClick={() => console.log('Quit')}>Quit</button>
    </div>
  );
};

export default Menu;