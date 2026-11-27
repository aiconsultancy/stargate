/** The write may have reached IRC, but the server did not confirm it. */
export class IrcDeliveryUnconfirmed extends Error {
  public constructor() {
    super("IRC delivery unconfirmed");
  }
}
