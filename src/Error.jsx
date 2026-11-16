import { useEffect, useState } from "react";
function Error(props) {
  const { message, setMessage } = props;

  const [cn, setCn] = useState("error-div");

  useEffect(() => {
    if (message == "") {
      return;
    }
    setCn("error-div error-in");
    const timeout = setTimeout(() => {
      setCn("error-div");
      setMessage("");
    }, 700);
    return () => clearTimeout(timeout);
  }, [message, setMessage]);

  return (
    <div className="error-container">
      <div className={cn}>Error: {message}</div>
    </div>
  );
}

export default Error;
