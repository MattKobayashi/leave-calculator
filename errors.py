"""Intentional input errors, separate from unexpected internal failures."""


class InputValidationError(ValueError):
    """A validation failure with a message safe for API clients.

    Use only application-authored messages, never text from a caught exception.
    """

    def __init__(self, public_message: str) -> None:
        super().__init__(public_message)
        self.public_message = public_message
